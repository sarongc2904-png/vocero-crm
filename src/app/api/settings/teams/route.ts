import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import { auditPrivilegedAction } from "@/server/auth/audit";
import {
  createTeam,
  deleteTeam,
  listTeams,
  renameTeam,
} from "@/server/auth/teams";

export const dynamic = "force-dynamic";

export const GET = withOrgPermissions(["teams.read"], async (session) => {
  return Response.json({ teams: await listTeams(session.organizationId) });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const POST = withOrgPermissions(["teams.manage"], async (session, req: Request) => {
  const body = await parseBody(req, createSchema);
  if (!body.ok) return body.response;

  try {
    const team = await createTeam(session.organizationId, body.data.name);
    await auditPrivilegedAction(session, {
      action: "team.create",
      targetType: "team",
      targetId: team.id,
      metadata: { name: team.name },
    });
    return Response.json({ team }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/unique|duplicate/i.test(message)) {
      return apiError(409, "duplicate_team", "Ya existe un equipo con ese nombre");
    }
    throw err;
  }
});

const updateSchema = z.object({
  teamId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120),
});

export const PATCH = withOrgPermissions(["teams.manage"], async (session, req: Request) => {
  const body = await parseBody(req, updateSchema);
  if (!body.ok) return body.response;

  try {
    const updated = await renameTeam({
      organizationId: session.organizationId,
      teamId: body.data.teamId,
      name: body.data.name,
    });
    if (!updated) return apiError(404, "not_found", "Equipo no encontrado en este tenant");
    await auditPrivilegedAction(session, {
      action: "team.rename",
      targetType: "team",
      targetId: body.data.teamId,
      metadata: { name: body.data.name },
    });
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/unique|duplicate/i.test(message)) {
      return apiError(409, "duplicate_team", "Ya existe un equipo con ese nombre");
    }
    throw err;
  }
});

const deleteSchema = z.object({
  teamId: z.string().trim().min(1),
});

export const DELETE = withOrgPermissions(["teams.manage"], async (session, req: Request) => {
  const body = await parseBody(req, deleteSchema);
  if (!body.ok) return body.response;

  if (!(await deleteTeam(session.organizationId, body.data.teamId))) {
    return apiError(404, "not_found", "Equipo no encontrado en este tenant");
  }
  await auditPrivilegedAction(session, {
    action: "team.delete",
    targetType: "team",
    targetId: body.data.teamId,
  });
  return Response.json({ ok: true });
});
