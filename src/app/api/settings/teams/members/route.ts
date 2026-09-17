import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import { auditPrivilegedAction } from "@/server/auth/audit";
import {
  addMemberToTeam,
  removeMemberFromTeam,
} from "@/server/auth/teams";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  teamId: z.string().trim().min(1),
  memberId: z.string().trim().min(1),
});

export const POST = withOrgPermissions(["teams.manage"], async (session, req: Request) => {
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const ok = await addMemberToTeam({
    organizationId: session.organizationId,
    teamId: body.data.teamId,
    memberId: body.data.memberId,
  });
  if (!ok) {
    return apiError(
      404,
      "not_found",
      "Equipo o usuario no encontrado, o el usuario está suspendido"
    );
  }

  await auditPrivilegedAction(session, {
    action: "team.member.add",
    targetType: "team",
    targetId: body.data.teamId,
    metadata: { memberId: body.data.memberId },
  });
  return Response.json({ ok: true }, { status: 201 });
});

export const DELETE = withOrgPermissions(["teams.manage"], async (session, req: Request) => {
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const ok = await removeMemberFromTeam({
    organizationId: session.organizationId,
    teamId: body.data.teamId,
    memberId: body.data.memberId,
  });
  if (!ok) return apiError(404, "not_found", "Asignación no encontrada en este tenant");

  await auditPrivilegedAction(session, {
    action: "team.member.remove",
    targetType: "team",
    targetId: body.data.teamId,
    metadata: { memberId: body.data.memberId },
  });
  return Response.json({ ok: true });
});
