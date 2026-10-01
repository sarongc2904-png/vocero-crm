import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { auditPrivilegedAction } from "@/server/auth/audit";
import { googleConnector } from "@/server/agenda/connectors/google";
import { getGoogleOAuthConfig } from "@/server/agenda/connectors/google-oauth";
import {
  deleteGoogleCredentials,
  getGoogleCredentials,
  saveGoogleCredentials,
  secretLast4,
} from "@/server/agenda/connectors/google-credentials";

export const dynamic = "force-dynamic";

/** 015 — Conexión de Google Calendar. Los secretos entran y no vuelven a salir. */

export const GET = withOrgPermissions(["settings.read"], async (session) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const creds = await getGoogleCredentials(session.organizationId);
  const oauthAvailable = Boolean(getGoogleOAuthConfig());
  if (!creds) return Response.json({ connection: null, oauthAvailable });
  return Response.json({
    oauthAvailable,
    connection: {
      status: creds.status,
      secretLast4: secretLast4(creds.clientSecret),
      fields: { clientId: creds.clientId, calendarId: creds.calendarId },
    },
  });
});

const credsSchema = z.object({
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().min(1),
  refreshToken: z.string().trim().min(1),
  calendarId: z.string().trim().optional(),
});

export const PUT = withOrgPermissions(["settings.update"], async (session, req: Request) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const body = await parseBody(req, credsSchema);
  if (!body.ok) return body.response;

  const calendarId = body.data.calendarId?.trim() || "primary";
  const check = await googleConnector.testConnection({
    ...body.data,
    calendarId,
    status: "connected",
  });
  if (!check.ok) return apiError(422, "google_invalid", check.error);

  await saveGoogleCredentials({
    organizationId: session.organizationId,
    ...body.data,
    calendarId,
  });

  // SEC-V6b: rotar el conector de calendario del tenant deja rastro (sin
  // secretos: solo last4 y los identificadores no sensibles).
  const secretLast4Value = secretLast4(body.data.clientSecret);
  await auditPrivilegedAction(session, {
    action: "settings.google.update",
    targetType: "channel_credentials",
    targetId: session.organizationId,
    metadata: {
      connector: "google",
      calendarId,
      clientId: body.data.clientId,
      secretLast4: secretLast4Value,
    },
  });

  return Response.json({
    connection: {
      status: "connected",
      secretLast4: secretLast4Value,
      fields: { clientId: body.data.clientId, calendarId },
    },
  });
});

export const DELETE = withOrgPermissions(["settings.update"], async (session) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  await deleteGoogleCredentials(session.organizationId);
  await auditPrivilegedAction(session, {
    action: "settings.google.delete",
    targetType: "channel_credentials",
    targetId: session.organizationId,
    metadata: { connector: "google" },
  });
  return Response.json({ ok: true });
});
