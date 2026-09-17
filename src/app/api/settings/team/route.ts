import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import { getAuth, runInternalSignup } from "@/lib/auth";
import { canAssignRole, canManageMember } from "@/lib/auth/member-policy";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { auditPrivilegedAction } from "@/server/auth/audit";

export const dynamic = "force-dynamic";

export const GET = withOrgPermissions(["users.read"], async (session) => {
  const db = getDb();
  const members = await db
    .select({
      id: schema.member.id,
      role: schema.member.role,
      createdAt: schema.member.createdAt,
      name: schema.user.name,
      email: schema.user.email,
    })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(scoped(schema.member.organizationId, session.organizationId));
  return Response.json({
    canManageMembers: true,
    members: members.map((m) => ({
      id: m.id,
      role: m.role,
      name: m.name,
      email: m.email,
      createdAt: m.createdAt.toISOString(),
    })),
  });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email(),
  password: z.string().min(8).max(128),
  role: z.enum(["admin", "agent"]).default("agent"),
});

const updateSchema = z.object({
  memberId: z.string().trim().min(1),
  role: z.enum(["admin", "agent"]),
});

const deleteSchema = z.object({
  memberId: z.string().trim().min(1),
});

/** Alta de cuenta de equipo dentro del tenant activo. */
export const POST = withOrgPermissions(["users.create"], async (session, req: Request) => {
  const body = await parseBody(req, createSchema);
  if (!body.ok) return body.response;
  const requestedRole = body.data.role ?? "agent";
  if (
    !canAssignRole({
      actorRole: session.role,
      nextRole: requestedRole,
      isSuperadmin: session.isSuperadmin,
    })
  ) {
    return apiError(403, "forbidden_role", "No puedes asignar ese rol");
  }

  const auth = getAuth();
  let newUserId: string;
  try {
    const result = await runInternalSignup(() =>
      auth.api.signUpEmail({
        body: {
          name: body.data.name,
          email: body.data.email,
          password: body.data.password,
        },
      })
    );
    newUserId = result.user.id;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "No se pudo crear la cuenta";
    if (/exist/i.test(message)) {
      return apiError(409, "duplicate", "Ya existe una cuenta con ese correo");
    }
    return apiError(422, "invalid", message);
  }

  const db = getDb();
  const memberId = newId("member");
  await db
    .insert(schema.member)
    .values({
      id: memberId,
      organizationId: session.organizationId,
      userId: newUserId,
      role: requestedRole,
    })
    .onConflictDoNothing();

  await auditPrivilegedAction(session, {
    action: "member.create",
    targetType: "member",
    targetId: memberId,
    metadata: { role: requestedRole },
  });

  return Response.json({ ok: true, memberId }, { status: 201 });
});

/** Cambia el rol operativo respetando la jerarquía owner > admin > agent. */
export const PATCH = withOrgPermissions(["users.update"], async (session, req: Request) => {
  const body = await parseBody(req, updateSchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const [target] = await db
    .select({ role: schema.member.role, userId: schema.member.userId })
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
    return apiError(409, "self_protected", "No puedes cambiar tu propio rol");
  }
  if (
    !canManageMember({
      actorRole: session.role,
      targetRole: target.role,
      isSuperadmin: session.isSuperadmin,
    }) ||
    !canAssignRole({
      actorRole: session.role,
      nextRole: body.data.role,
      isSuperadmin: session.isSuperadmin,
    })
  ) {
    return apiError(403, "forbidden_role", "No puedes modificar ese rol");
  }

  await db
    .update(schema.member)
    .set({ role: body.data.role })
    .where(
      and(
        eq(schema.member.id, body.data.memberId),
        eq(schema.member.organizationId, session.organizationId)
      )
    );

  await auditPrivilegedAction(session, {
    action: "member.role.update",
    targetType: "member",
    targetId: body.data.memberId,
    metadata: { from: target.role, to: body.data.role },
  });

  return Response.json({ ok: true, role: body.data.role });
});

/** Quita el acceso al tenant. El borrado global de cuenta tiene una ruta aparte. */
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

  if (!target) {
    return apiError(404, "not_found", "La cuenta ya no pertenece a este equipo");
  }
  if (target.userId === session.userId) {
    return apiError(409, "self_protected", "No puedes quitar tu propio acceso");
  }
  if (
    !canManageMember({
      actorRole: session.role,
      targetRole: target.role,
      isSuperadmin: session.isSuperadmin,
    })
  ) {
    return apiError(403, "forbidden_role", "No puedes quitar el acceso a ese usuario");
  }

  await db
    .delete(schema.member)
    .where(
      and(
        eq(schema.member.id, body.data.memberId),
        eq(schema.member.organizationId, session.organizationId)
      )
    );

  await auditPrivilegedAction(session, {
    action: "member.access.remove",
    targetType: "member",
    targetId: body.data.memberId,
    metadata: { userId: target.userId, role: target.role },
  });

  return Response.json({ ok: true });
});
