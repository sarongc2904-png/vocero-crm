import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import {
  atribucionDisabledResponse,
  atribucionEnabled,
} from "@/server/attribution/flag";
import {
  deleteCapiSettings,
  getCapiSettingsView,
  saveCapiSettings,
  stageBelongsToOrg,
} from "@/server/attribution/settings";
import { getCredentialsByOrg } from "@/server/whatsapp/credentials";

export const dynamic = "force-dynamic";

export const GET = withOrgPermissions(["settings.read"], async (session) => {
  if (!atribucionEnabled()) return atribucionDisabledResponse();
  const capi = await getCapiSettingsView(session.organizationId);
  return Response.json({ capi });
});

const putSchema = z.object({
  datasetId: z.string().trim().min(1),
  token: z.string().trim().min(1).optional(),
  qualifiedStageId: z.string().trim().min(1).nullish(),
});

export const PUT = withOrgPermissions(["settings.update"], async (session, req: Request) => {
  if (!atribucionEnabled()) return atribucionDisabledResponse();

  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;

  let token = body.data.token;
  if (!token) {
    const credentials = await getCredentialsByOrg(session.organizationId);
    if (!credentials) {
      return apiError(
        409,
        "sin_whatsapp",
        "No hay conexión de WhatsApp de la cual reusar el token: pega uno explícito"
      );
    }
    token = credentials.token;
  }

  const qualifiedStageId = body.data.qualifiedStageId ?? null;
  if (
    qualifiedStageId &&
    !(await stageBelongsToOrg(session.organizationId, qualifiedStageId))
  ) {
    return apiError(422, "etapa_invalida", "Esa etapa no es de este negocio");
  }

  await saveCapiSettings({
    organizationId: session.organizationId,
    datasetId: body.data.datasetId,
    token,
    qualifiedStageId,
  });
  return Response.json({ ok: true });
});

export const DELETE = withOrgPermissions(["settings.update"], async (session) => {
  if (!atribucionEnabled()) return atribucionDisabledResponse();
  await deleteCapiSettings(session.organizationId);
  return Response.json({ ok: true });
});
