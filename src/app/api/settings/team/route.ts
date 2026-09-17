import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import { getAuth, runInternalSignup } from "@/lib/auth";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";

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
  await db
    .insert(schema.member)
    .values({
      id: newId("member"),
      organizationId: session.organizationId,
      userId: newUserId,
      role: body.data.role,
    })
    .onConflictDoNothing();

  return Response.json({ ok: true }, { status: 201 });
});

/** Cambia el rol operativo sin permitir degradar ni sustituir al owner. */
export const PATCH = withOrgPermissions(["users.update"], async (session, req: Request) => {
  const body = await parseBody(req, updateSchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const [target] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.id, body.data.memberId),
        scoped(schema.member.organizationId, session.organizationId)
      )
    )
    .limit(1);

  if (!target) return apiError(404, "not_found", "Usuario no encontrado en este tenant");
  if (target.role === "owner") {
    return apiError(409, "owner_protected", "No se puede modificar al propietario");
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

  return Response.json({ ok: true, role: body.data.role });
});

/** Borrado de acceso: owner o superadmin; nunca elimina al propietario. */
export const DELETE = withOrgPermissions(["users.delete"], async (session, req: Request) => {
  const body = await parseBody(req, deleteSchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const [target] = await db
    .select({
      userId: schema.member.userId,
      role: schema.member.role,
    })
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
  if (target.role === "owner" || target.userId === session.userId) {
    return apiError(409, "owner_protected", "No se puede eliminar al propietario");
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(schema.member)
      .where(
        and(
          eq(schema.member.id, body.data.memberId),
          eq(schema.member.organizationId, session.organizationId)
        )
      );

    // Si la cuenta pertenece a otra organización, conserva su acceso allí.
    const [remainingMembership] = await tx
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(eq(schema.member.userId, target.userId))
      .limit(1);

    if (!remainingMembership) {
      await tx.delete(schema.user).where(eq(schema.user.id, target.userId));
    }
  });

  return Response.json({ ok: true });
});
