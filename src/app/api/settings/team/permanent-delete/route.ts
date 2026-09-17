import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import { canManageMember } from "@/lib/auth/member-policy";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { auditPrivilegedAction } from "@/server/auth/audit";

export const dynamic = "force-dynamic";

const deleteSchema = z.object({
  memberId: z.string().trim().min(1),
  confirm: z.literal("DELETE"),
});

/**
 * Borrado global e irreversible. Requiere confirmación literal y que la cuenta
 * no tenga memberships en otros tenants. Quitar acceso a un solo tenant se hace
 * con DELETE /api/settings/team.
 */
export const DELETE = withOrgPermissions(["users.delete"], async (session, req: Request) => {
  const body = await parseBody(req, deleteSchema);
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
    return apiError(409, "self_protected", "No puedes borrar tu propia cuenta desde esta ruta");
  }
  if (
    !canManageMember({
      actorRole: session.role,
      targetRole: target.role,
      isSuperadmin: session.isSuperadmin,
    })
  ) {
    return apiError(403, "forbidden_role", "No puedes borrar a ese usuario");
  }

  const [otherMembership] = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.userId, target.userId),
        ne(schema.member.id, body.data.memberId)
      )
    )
    .limit(1);

  if (otherMembership) {
    return apiError(
      409,
      "other_memberships",
      "La cuenta pertenece a otros tenants; elimina primero esos accesos"
    );
  }

  await db.delete(schema.user).where(eq(schema.user.id, target.userId));

  await auditPrivilegedAction(session, {
    action: "user.permanent_delete",
    targetType: "user",
    targetId: target.userId,
    metadata: { memberId: body.data.memberId },
  });

  return Response.json({ ok: true, deletedUserId: target.userId });
});
