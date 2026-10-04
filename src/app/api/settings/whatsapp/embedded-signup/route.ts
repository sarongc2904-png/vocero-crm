import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import { isEmbeddedSignupConfigured } from "@/lib/env";
import { auditPrivilegedAction } from "@/server/auth/audit";
import {
  assertPhoneNumberAvailableForOrg,
  CredentialsOwnershipError,
  saveCredentials,
} from "@/server/whatsapp/credentials";
import { subscribeAppToWaba, testConnection } from "@/server/whatsapp/connect";
import {
  exchangeCodeForToken,
  extendToken,
  registerPhoneNumberIfNeeded,
  verifyPhoneNumberBelongsToWaba,
  verifyEmbeddedSignupState,
} from "@/server/whatsapp/embedded-signup";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  code: z.string().trim().min(1),
  state: z.string().trim().min(1),
  wabaId: z.string().trim().min(1),
  phoneNumberId: z.string().trim().min(1),
});

/**
 * Completa Embedded Signup del lado del servidor: el navegador solo trae un
 * `code` de un solo uso (nunca un token — el App Secret no sale de aquí) más
 * el waba_id/phone_number_id que el cliente eligió en el login de Meta.
 */
export const POST = withOrgPermissions(["settings.update"], async (session, req: Request) => {
  if (!isEmbeddedSignupConfigured()) {
    return apiError(
      501,
      "not_configured",
      "Embedded Signup no está configurado en esta instancia"
    );
  }

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  if (
    !verifyEmbeddedSignupState({
      state: body.data.state,
      sessionId: session.sessionId,
      organizationId: session.organizationId,
    })
  ) {
    return apiError(
      422,
      "invalid_signup_state",
      "La sesión de conexión expiró. Inicia nuevamente desde Ajustes."
    );
  }

  try {
    await assertPhoneNumberAvailableForOrg(
      session.organizationId,
      body.data.phoneNumberId
    );
  } catch (err) {
    if (err instanceof CredentialsOwnershipError) {
      return apiError(409, "phone_already_connected", err.message);
    }
    throw err;
  }

  let shortLived: string;
  try {
    shortLived = await exchangeCodeForToken(body.data.code);
  } catch {
    return apiError(
      422,
      "token_exchange_failed",
      "No pudimos autorizar la conexión con Meta. Intenta nuevamente."
    );
  }

  let token: string;
  try {
    token = await extendToken(shortLived);
  } catch {
    return apiError(
      422,
      "token_extension_failed",
      "No pudimos completar la conexión segura con Meta. Intenta nuevamente."
    );
  }

  try {
    const belongsToWaba = await verifyPhoneNumberBelongsToWaba(
      body.data.wabaId,
      body.data.phoneNumberId,
      token
    );
    if (!belongsToWaba) {
      return apiError(
        422,
        "phone_waba_mismatch",
        "El número seleccionado no pertenece a la cuenta de WhatsApp indicada."
      );
    }
  } catch {
    return apiError(
      503,
      "phone_waba_check_failed",
      "No pudimos verificar el número con Meta. Intenta nuevamente."
    );
  }

  const check = await testConnection(body.data.phoneNumberId, token);
  if (!check.ok) {
    const status = check.code === "meta_unavailable" ? 503 : 422;
    return apiError(status, check.code, check.message);
  }

  const registration = await registerPhoneNumberIfNeeded(
    body.data.phoneNumberId,
    token
  );
  if (registration.status === "pending") {
    return apiError(
      409,
      registration.code,
      "El número aún tiene una verificación pendiente en Meta. Complétala e intenta nuevamente."
    );
  }
  if (registration.status === "failed") {
    const unavailable = registration.code === "meta_unavailable";
    return apiError(
      unavailable ? 503 : 422,
      registration.code,
      unavailable
        ? "Meta no está disponible en este momento. Intenta nuevamente."
        : "No pudimos registrar el número en Meta. Revisa su configuración e intenta nuevamente."
    );
  }

  const subscribed = await subscribeAppToWaba(body.data.wabaId, token);
  if (!subscribed) {
    return apiError(
      422,
      "webhook_subscription_failed",
      "Meta autorizó el número, pero no pudimos activar la recepción de mensajes. Intenta nuevamente."
    );
  }

  await saveCredentials({
    organizationId: session.organizationId,
    wabaId: body.data.wabaId,
    phoneNumberId: body.data.phoneNumberId,
    token,
    displayPhoneNumber: check.displayPhoneNumber,
    verifiedName: check.verifiedName,
  });

  // SEC-V6b: conectar el canal por Embedded Signup rota las credenciales del
  // tenant. El `code` y el token NUNCA entran al log.
  await auditPrivilegedAction(session, {
    action: "settings.whatsapp.embedded_signup",
    targetType: "channel_credentials",
    targetId: session.organizationId,
    metadata: {
      channel: "whatsapp",
    },
  });

  return Response.json({ ok: true, displayPhoneNumber: check.displayPhoneNumber });
});
