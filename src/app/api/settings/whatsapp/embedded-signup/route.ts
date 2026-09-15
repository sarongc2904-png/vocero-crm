import { z } from "zod";
import { apiError, parseBody, withOrgRoles } from "@/lib/api";
import { isEmbeddedSignupConfigured } from "@/lib/env";
import { saveCredentials } from "@/server/whatsapp/credentials";
import { subscribeAppToWaba, testConnection } from "@/server/whatsapp/connect";
import {
  EmbeddedSignupError,
  exchangeCodeForToken,
  extendToken,
  registerPhoneNumberIfNeeded,
} from "@/server/whatsapp/embedded-signup";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  code: z.string().trim().min(1),
  wabaId: z.string().trim().min(1),
  phoneNumberId: z.string().trim().min(1),
});

/**
 * Completa Embedded Signup del lado del servidor: el navegador solo trae un
 * `code` de un solo uso (nunca un token — el App Secret no sale de aquí) más
 * el waba_id/phone_number_id que el cliente eligió en el login de Meta.
 */
export const POST = withOrgRoles(["owner", "admin"], async (session, req: Request) => {
  if (!isEmbeddedSignupConfigured()) {
    return apiError(
      501,
      "not_configured",
      "Embedded Signup no está configurado en esta instancia"
    );
  }

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  let token: string;
  try {
    const shortLived = await exchangeCodeForToken(body.data.code);
    token = await extendToken(shortLived);
  } catch (err) {
    if (err instanceof EmbeddedSignupError) {
      return apiError(422, "exchange_failed", err.message);
    }
    throw err;
  }

  const check = await testConnection(body.data.phoneNumberId, token);
  if (!check.ok) {
    const status = check.code === "meta_unavailable" ? 503 : 422;
    return apiError(status, check.code, check.message);
  }

  // Best-effort, en ese orden: registrar el número y suscribir el webhook no
  // deben impedir guardar una conexión que Meta ya validó arriba.
  await registerPhoneNumberIfNeeded(body.data.phoneNumberId, token).catch((err) =>
    console.warn("[embedded-signup] registro falló:", err)
  );

  await saveCredentials({
    organizationId: session.organizationId,
    wabaId: body.data.wabaId,
    phoneNumberId: body.data.phoneNumberId,
    token,
    displayPhoneNumber: check.displayPhoneNumber,
    verifiedName: check.verifiedName,
  });

  await subscribeAppToWaba(body.data.wabaId, token);

  return Response.json({ ok: true, displayPhoneNumber: check.displayPhoneNumber });
});
