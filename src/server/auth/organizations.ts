import { asc, count, eq, sql } from "drizzle-orm";
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

export const BUSINESS_NAME_MAX_LENGTH = 120;

export class OrganizationBootstrapError extends Error {
  constructor(
    readonly code: "invalid_name" | "membership_not_found" | "signup_closed"
  ) {
    super(
      code === "invalid_name"
        ? `El nombre del negocio debe tener entre 2 y ${BUSINESS_NAME_MAX_LENGTH} caracteres`
        : code === "signup_closed"
          ? "El registro público no está habilitado en este momento"
          : "No se pudo resolver la organización creada"
    );
    this.name = "OrganizationBootstrapError";
  }
}

function normalizedBusinessName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (normalized.length < 2 || normalized.length > BUSINESS_NAME_MAX_LENGTH) {
    throw new OrganizationBootstrapError("invalid_name");
  }
  return normalized;
}

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
  const [plan] = await tx
    .select({
      id: schema.commercialPlan.id,
      trialDays: schema.commercialPlan.trialDays,
    })
    .from(schema.commercialPlan)
    .where(eq(schema.commercialPlan.id, "plan_conecta_mx"))
    .limit(1);
  if (!plan) throw new Error("commercial_plan_not_configured");

  const trialStartedAt = new Date();
  const trialEndsAt = new Date(
    trialStartedAt.getTime() + plan.trialDays * 86_400_000
  );
  await tx.insert(schema.organizationEntitlement).values({
    id: newId("entitlement"),
    organizationId: input.organizationId,
    planId: plan.id,
    status: "trial",
    trialStartedAt,
    trialEndsAt,
  });
  await tx.insert(schema.onboardingProgress).values({
    id: newId("onboardingProgress"),
    organizationId: input.organizationId,
    currentStep: 1,
    completedSteps: ["business"],
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
  const normalizedName = normalizedBusinessName(name);
  return getDb().transaction(async (tx) => {
    // Serializa solamente la asignación del slug para que dos altas con el
    // mismo nombre no dependan de reintentos ni de errores de constraint.
    await tx.execute(sql`select pg_advisory_xact_lock(874202)`);
    const base = slugBase(normalizedName);
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
      name: normalizedName,
      slug,
    });
    return { id, name: normalizedName, slug };
  });
}

/**
 * Bootstrap self-serve idempotente. El candado se deriva del usuario: dos
 * clics/reintentos concurrentes nunca crean dos memberships ni dos tenants.
 */
export async function createSelfServeOrganizationForOwner(
  ownerUserId: string,
  name: string,
  options: { publicSignupOpen: boolean }
): Promise<{ id: string; name: string; slug: string; created: boolean }> {
  const normalizedName = normalizedBusinessName(name);
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${ownerUserId}, 874204))`
    );

    const memberships = await tx
      .select({ organizationId: schema.member.organizationId })
      .from(schema.member)
      .where(eq(schema.member.userId, ownerUserId))
      .orderBy(asc(schema.member.createdAt), asc(schema.member.id))
      .limit(1);
    const existingMembership = memberships[0];
    if (existingMembership) {
      const organizations = await tx
        .select({
          id: schema.organization.id,
          name: schema.organization.name,
          slug: schema.organization.slug,
        })
        .from(schema.organization)
        .where(eq(schema.organization.id, existingMembership.organizationId))
        .limit(1);
      const existing = organizations[0];
      if (!existing) throw new OrganizationBootstrapError("membership_not_found");
      return { ...existing, slug: existing.slug ?? "", created: false };
    }

    if (!options.publicSignupOpen) {
      await tx.execute(sql`select pg_advisory_xact_lock(874201)`);
      const organizations = await tx
        .select({ n: count() })
        .from(schema.organization);
      if ((organizations[0]?.n ?? 0) > 0) {
        throw new OrganizationBootstrapError("signup_closed");
      }
    }

    // El lock de slug se conserva separado: usuarios distintos pueden pedir el
    // mismo nombre y reciben sufijos únicos sin depender de un error de índice.
    await tx.execute(sql`select pg_advisory_xact_lock(874202)`);
    const base = slugBase(normalizedName);
    let slug = base;
    for (let suffix = 2; ; suffix += 1) {
      const existing = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.slug, slug))
        .limit(1);
      if (!existing[0]) break;
      slug = `${base.slice(0, Math.max(1, 48 - String(suffix).length - 1))}-${suffix}`;
    }

    const id = newId("organization");
    await initializeOrganization(tx, {
      organizationId: id,
      ownerUserId,
      name: normalizedName,
      slug,
    });
    return { id, name: normalizedName, slug, created: true };
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

/** Valida un target de tenant sin revelar ni aceptar IDs inexistentes. */
export async function organizationExists(organizationId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId))
    .limit(1);
  return Boolean(row);
}
