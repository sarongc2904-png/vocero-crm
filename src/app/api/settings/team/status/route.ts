import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import { canManageMember } from "@/lib/auth/member-policy";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { auditPrivilegedAction } from "@/server/auth/audit";
import { setMemberSuspension } from "@/server/auth/suspension";

export const dynamic = "force-dynamic";

const schemaBody = z.object({
  memberId: z.string().trim().min(1),
  suspended: z.boolean(),
  reason: z.string().trim().max(300).optional(),
});

export const PATCH = withOrgPermissions(["users.suspend"], async (session, req: Request) => {
  const body = await parseBody(req, schemaBody);
  if (!body.ok) return body.response;

  const db = getDb();
  const [target] = await db
    .select({ userId: schema.member.userId, role: schema.member.role })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.id, body.data.memberId),
        scoped(schema.member.organizationId, session.organizationId)
      )
    )
    .limit(1);

  if (!target) return apiError(404, "not_found", "Usuario no encontrado en este tenant");
  if (target.userId === session.userId) {
    return apiError(409, "self_protected", "No puedes suspender tu propio acceso");
  }
  if (
    !canManageMember({
      actorRole: session.role,
      targetRole: target.role,
      isSuperadmin: session.isSuperadmin,
    })
  ) {
    return apiError(403, "forbidden_role", "No puedes suspender a ese usuario");
  }

  const updated = await setMemberSuspension({
    organizationId: session.organizationId,
    memberId: body.data.memberId,
    suspended: body.data.suspended,
    reason: body.data.reason,
    actorUserId: session.userId,
  });
  if (!updated) return apiError(404, "not_found", "Usuario no encontrado en este tenant");

  await auditPrivilegedAction(session, {
    action: body.data.suspended ? "member.suspend" : "member.restore",
    targetType: "member",
    targetId: body.data.memberId,
    metadata: body.data.suspended ? { reason: body.data.reason ?? null } : null,
  });

  return Response.json({
    ok: true,
    suspended: body.data.suspended,
    suspendedAt: updated.suspendedAt?.toISOString() ?? null,
  });
});
