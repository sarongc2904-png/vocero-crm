import { asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import {
  normalizeOrganizationRole,
  type OrganizationRole,
} from "@/lib/auth/roles";

export const SEED_STAGES: {
  name: string;
  kind: "open" | "won" | "lost";
}[] = [
  { name: "Nuevo", kind: "open" },
  { name: "En conversación", kind: "open" },
  { name: "Interesado", kind: "open" },
  { name: "Cliente", kind: "won" },
  { name: "Perdido", kind: "lost" },
];

type OrganizationTx = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

/** Crea el tenant y todo su estado inicial dentro de una transacción existente. */
export async function initializeOrganization(
  tx: OrganizationTx,
  input: {
    organizationId: string;
    ownerUserId: string;
    name: string;
    slug: string;
  }
): Promise<void> {
  await tx.insert(schema.organization).values({
    id: input.organizationId,
    name: input.name,
    slug: input.slug,
  });
  await tx.insert(schema.member).values({
    id: newId("member"),
    organizationId: input.organizationId,
    userId: input.ownerUserId,
    role: "owner",
  });
  await tx.insert(schema.pipelineStage).values(
    SEED_STAGES.map((stage, position) => ({
      id: newId("stage"),
      organizationId: input.organizationId,
      name: stage.name,
      position,
      kind: stage.kind,
    }))
  );
  await tx.insert(schema.agentProfile).values({
    id: newId("agentProfile"),
    organizationId: input.organizationId,
  });
}

function slugBase(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "organizacion";
}

/** Crea una organización nueva con slug único y bootstrap idéntico al inicial. */
export async function createOrganizationForOwner(
  ownerUserId: string,
  name: string
): Promise<{ id: string; name: string; slug: string }> {
  return getDb().transaction(async (tx) => {
    // Serializa solamente la asignación del slug para que dos altas con el
    // mismo nombre no dependan de reintentos ni de errores de constraint.
    await tx.execute(sql`select pg_advisory_xact_lock(874202)`);
    const base = slugBase(name);
    let slug = base;
    for (let suffix = 2; ; suffix += 1) {
      const [existing] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.slug, slug))
        .limit(1);
      if (!existing) break;
      slug = `${base.slice(0, Math.max(1, 48 - String(suffix).length - 1))}-${suffix}`;
    }

    const id = newId("organization");
    await initializeOrganization(tx, {
      organizationId: id,
      ownerUserId,
      name,
      slug,
    });
    return { id, name, slug };
  });
}

export type ActiveMembership = {
  organizationId: string;
  role: OrganizationRole;
  usedFallback: boolean;
};

/**
 * Resuelve exclusivamente memberships del usuario. La organización solicitada
 * solo gana cuando existe el par user_id + organization_id; nunca se acepta un
 * id libre proveniente del cliente.
 */
export async function resolveActiveMembership(
  userId: string,
  activeOrganizationId: string | null | undefined
): Promise<ActiveMembership | null> {
  const rows = await getDb()
    .select({
      organizationId: schema.member.organizationId,
      role: schema.member.role,
    })
    .from(schema.member)
    .where(eq(schema.member.userId, userId))
    .orderBy(asc(schema.member.createdAt), asc(schema.member.id));

  const memberships = rows.flatMap((row) => {
    const role = normalizeOrganizationRole(row.role);
    return role ? [{ ...row, role }] : [];
  });
  if (memberships.length === 0) return null;

  const active = activeOrganizationId
    ? memberships.find((row) => row.organizationId === activeOrganizationId)
    : undefined;
  const selected = active ?? memberships[0]!;
  return {
    ...selected,
    usedFallback: selected.organizationId !== activeOrganizationId,
  };
}
