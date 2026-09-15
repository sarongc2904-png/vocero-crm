import { z } from "zod";
import { apiError, parseBody, withOrgRoles } from "@/lib/api";
import { isEmbeddedSignupConfigured } from "@/lib/env";
import {
  getCredentialsByOrg,
  saveCredentials,
  tokenLast4,
} from "@/server/whatsapp/credentials";
import { subscribeAppToWaba, testConnection } from "@/server/whatsapp/connect";

export const dynamic = "force-dynamic";

export const GET = withOrgRoles(["owner", "admin"], async (session) => {
  const creds = await getCredentialsByOrg(session.organizationId);
  const embeddedSignup = isEmbeddedSignupConfigured()
    ? {
        available: true as const,
        appId: process.env.META_APP_ID!,
        configId: process.env.META_EMBEDDED_SIGNUP_CONFIG_ID!,
        graphVersion: process.env.META_GRAPH_API_VERSION ?? "v25.0",
      }
    : { available: false as const };
  if (!creds) return Response.json({ connection: null, embeddedSignup });
  return Response.json({
    connection: {
      wabaId: creds.wabaId,
      phoneNumberId: creds.phoneNumberId,
      displayPhoneNumber: creds.displayPhoneNumber,
      verifiedName: creds.verifiedName,
      status: creds.status,
      tokenLast4: tokenLast4(creds.token),
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
export const PUT = withOrgRoles(["owner", "admin"], async (session, req: Request) => {
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;

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

  // Best-effort: necesaria en modo directo; el modo agencia usa su override.
  await subscribeAppToWaba(body.data.wabaId, body.data.token);

  return Response.json({
    ok: true,
    displayPhoneNumber: check.displayPhoneNumber,
  });
});
