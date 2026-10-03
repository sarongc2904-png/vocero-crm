import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import { isEmbeddedSignupConfigured } from "@/lib/env";
import { auditPrivilegedAction } from "@/server/auth/audit";
import {
  assertPhoneNumberAvailableForOrg,
  CredentialsOwnershipError,
  deleteCredentialsByOrg,
  getCredentialsByOrg,
  markReconnectRequired,
  saveCredentials,
} from "@/server/whatsapp/credentials";
import { subscribeAppToWaba, testConnection } from "@/server/whatsapp/connect";
import { createEmbeddedSignupState } from "@/server/whatsapp/embedded-signup";

export const dynamic = "force-dynamic";

export const GET = withOrgPermissions(["settings.read"], async (session) => {
  const creds = await getCredentialsByOrg(session.organizationId);
  const embeddedSignup = isEmbeddedSignupConfigured()
    ? {
        available: true as const,
        appId: process.env.META_APP_ID!,
        configId: process.env.META_EMBEDDED_SIGNUP_CONFIG_ID!,
        graphVersion: process.env.META_GRAPH_API_VERSION ?? "v25.0",
        state: createEmbeddedSignupState({
          sessionId: session.sessionId,
          organizationId: session.organizationId,
        }),
      }
    : { available: false as const };
  if (!creds) return Response.json({ connection: null, embeddedSignup });

  let status: "connected" | "reconnect_required" | "error" = creds.status;
  let errorMessage: string | null = null;
  if (status === "connected") {
    const check = await testConnection(creds.phoneNumberId, creds.token);
    if (!check.ok && check.code === "invalid_token") {
      await markReconnectRequired(session.organizationId);
      status = "reconnect_required";
    } else if (!check.ok) {
      status = "error";
      errorMessage =
        check.code === "meta_unavailable"
          ? "No pudimos verificar la conexión con Meta. Intenta de nuevo más tarde."
          : "Meta no pudo validar la conexión actual. Revisa o reconecta tu número.";
    }
  }

  return Response.json({
    connection: {
      wabaId: creds.wabaId,
      phoneNumberId: creds.phoneNumberId,
      displayPhoneNumber: creds.displayPhoneNumber,
      verifiedName: creds.verifiedName,
      status,
      errorMessage,
    },
    embeddedSignup,
  });
});

const putSchema = z.object({
  wabaId: z.string().trim().min(1),
  phoneNumberId: z.string().trim().min(1),
  token: z.string().trim().min(1),
});

/** Guarda la conexión: re-valida contra Meta, cifra y suscribe (FR-040). */
export const PUT = withOrgPermissions(["settings.update"], async (session, req: Request) => {
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;

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

  const check = await testConnection(body.data.phoneNumberId, body.data.token);
  if (!check.ok) {
    const status = check.code === "meta_unavailable" ? 503 : 422;
    return apiError(status, check.code, check.message);
  }

  await saveCredentials({
    organizationId: session.organizationId,
    wabaId: body.data.wabaId,
    phoneNumberId: body.data.phoneNumberId,
    token: body.data.token,
    displayPhoneNumber: check.displayPhoneNumber,
    verifiedName: check.verifiedName,
  });

  await subscribeAppToWaba(body.data.wabaId, body.data.token);

  // SEC-V6b: rotar las credenciales del canal es el camino del secuestro
  // silencioso. Se audita sin incluir ninguna parte del token.
  await auditPrivilegedAction(session, {
    action: "settings.whatsapp.update",
    targetType: "channel_credentials",
    targetId: session.organizationId,
    metadata: {
      channel: "whatsapp",
      wabaId: body.data.wabaId,
      phoneNumberId: body.data.phoneNumberId,
    },
  });

  return Response.json({
    ok: true,
    displayPhoneNumber: check.displayPhoneNumber,
  });
});

export const DELETE = withOrgPermissions(
  ["settings.update"],
  async (session) => {
    await deleteCredentialsByOrg(session.organizationId);
    await auditPrivilegedAction(session, {
      action: "settings.whatsapp.disconnect",
      targetType: "channel_credentials",
      targetId: session.organizationId,
      metadata: { channel: "whatsapp" },
    });
    return Response.json({ ok: true });
  }
);
