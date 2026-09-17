import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { zoomConnector } from "@/server/agenda/connectors/zoom";
import {
  deleteZoomCredentials,
  getZoomCredentials,
  saveZoomCredentials,
  secretLast4,
} from "@/server/agenda/connectors/zoom-credentials";

export const dynamic = "force-dynamic";

export const GET = withOrgPermissions(["settings.read"], async (session) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const creds = await getZoomCredentials(session.organizationId);
  if (!creds) return Response.json({ connection: null });
  return Response.json({
    connection: {
      status: creds.status,
      secretLast4: secretLast4(creds.clientSecret),
      fields: { accountId: creds.accountId, clientId: creds.clientId },
    },
  });
});

const credsSchema = z.object({
  accountId: z.string().trim().min(1),
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().min(1),
});

export const PUT = withOrgPermissions(["settings.update"], async (session, req: Request) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const body = await parseBody(req, credsSchema);
  if (!body.ok) return body.response;

  const check = await zoomConnector.testConnection({
    ...body.data,
    status: "connected",
  });
  if (!check.ok) return apiError(422, "zoom_invalid", check.error);

  await saveZoomCredentials({
    organizationId: session.organizationId,
    ...body.data,
  });

  return Response.json({
    connection: {
      status: "connected",
      secretLast4: secretLast4(body.data.clientSecret),
      fields: { accountId: body.data.accountId, clientId: body.data.clientId },
    },
  });
});

export const DELETE = withOrgPermissions(["settings.update"], async (session) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  await deleteZoomCredentials(session.organizationId);
  return Response.json({ ok: true });
});
