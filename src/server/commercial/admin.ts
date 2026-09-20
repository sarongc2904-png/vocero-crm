import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";

export const COMMERCIAL_ACTIONS = [
  "extend_trial",
  "activate",
  "suspend",
  "cancel",
  "reactivate",
  "change_plan",
] as const;

export type CommercialAdminAction = (typeof COMMERCIAL_ACTIONS)[number];

export async function listCommercialAccounts() {
  const db = getDb();
  const rows = await db
    .select({
      organizationId: schema.organization.id,
      organizationName: schema.organization.name,
      organizationSlug: schema.organization.slug,
      createdAt: schema.organization.createdAt,
      entitlementId: schema.organizationEntitlement.id,
      status: schema.organizationEntitlement.status,
      trialStartedAt: schema.organizationEntitlement.trialStartedAt,
      trialEndsAt: schema.organizationEntitlement.trialEndsAt,
      currentPeriodEndsAt: schema.organizationEntitlement.currentPeriodEndsAt,
      planId: schema.commercialPlan.id,
      planCode: schema.commercialPlan.code,
      planName: schema.commercialPlan.name,
      monthlyPriceCents: schema.commercialPlan.monthlyPriceCents,
      currency: schema.commercialPlan.currency,
      trialDays: schema.commercialPlan.trialDays,
    })
    .from(schema.organization)
    .leftJoin(
      schema.organizationEntitlement,
      eq(schema.organizationEntitlement.organizationId, schema.organization.id)
    )
    .leftJoin(
      schema.commercialPlan,
      eq(schema.commercialPlan.id, schema.organizationEntitlement.planId)
    )
    .orderBy(asc(schema.organization.createdAt), asc(schema.organization.name));

  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    trialStartedAt: row.trialStartedAt?.toISOString() ?? null,
    trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
    currentPeriodEndsAt: row.currentPeriodEndsAt?.toISOString() ?? null,
  }));
}

export async function listCommercialPlans() {
  return getDb()
    .select({
      id: schema.commercialPlan.id,
      code: schema.commercialPlan.code,
      name: schema.commercialPlan.name,
      monthlyPriceCents: schema.commercialPlan.monthlyPriceCents,
      currency: schema.commercialPlan.currency,
      trialDays: schema.commercialPlan.trialDays,
      active: schema.commercialPlan.active,
    })
    .from(schema.commercialPlan)
    .orderBy(asc(schema.commercialPlan.monthlyPriceCents));
}

export async function updateCommercialAccount(input: {
  organizationId: string;
  action: CommercialAdminAction;
  days?: number;
  planId?: string;
}) {
  const db = getDb();
  const [entitlement] = await db
    .select()
    .from(schema.organizationEntitlement)
    .where(eq(schema.organizationEntitlement.organizationId, input.organizationId))
    .limit(1);
  if (!entitlement) throw new Error("entitlement_not_found");

  const now = new Date();

  if (input.action === "extend_trial") {
    const days = Math.max(1, Math.min(365, input.days ?? 1));
    const base =
      entitlement.trialEndsAt && entitlement.trialEndsAt.getTime() > now.getTime()
        ? entitlement.trialEndsAt
        : now;
    const trialEndsAt = new Date(base.getTime() + days * 86_400_000);
    await db
      .update(schema.organizationEntitlement)
      .set({
        status: "trial",
        trialStartedAt: entitlement.trialStartedAt ?? now,
        trialEndsAt,
        suspendedAt: null,
        cancelledAt: null,
        updatedAt: now,
      })
      .where(eq(schema.organizationEntitlement.organizationId, input.organizationId));
  } else if (input.action === "activate" || input.action === "reactivate") {
    await db
      .update(schema.organizationEntitlement)
      .set({
        status: "active",
        suspendedAt: null,
        cancelledAt: null,
        updatedAt: now,
      })
      .where(eq(schema.organizationEntitlement.organizationId, input.organizationId));
  } else if (input.action === "suspend") {
    await db
      .update(schema.organizationEntitlement)
      .set({
        status: "suspended",
        suspendedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.organizationEntitlement.organizationId, input.organizationId));
  } else if (input.action === "cancel") {
    await db
      .update(schema.organizationEntitlement)
      .set({
        status: "cancelled",
        cancelledAt: now,
        updatedAt: now,
      })
      .where(eq(schema.organizationEntitlement.organizationId, input.organizationId));
  } else if (input.action === "change_plan") {
    if (!input.planId) throw new Error("plan_required");
    const [plan] = await db
      .select({ id: schema.commercialPlan.id })
      .from(schema.commercialPlan)
      .where(eq(schema.commercialPlan.id, input.planId))
      .limit(1);
    if (!plan) throw new Error("plan_not_found");
    await db
      .update(schema.organizationEntitlement)
      .set({ planId: plan.id, updatedAt: now })
      .where(eq(schema.organizationEntitlement.organizationId, input.organizationId));
  }

  const [updated] = await db
    .select({
      organizationId: schema.organizationEntitlement.organizationId,
      status: schema.organizationEntitlement.status,
      planId: schema.organizationEntitlement.planId,
      trialEndsAt: schema.organizationEntitlement.trialEndsAt,
      currentPeriodEndsAt: schema.organizationEntitlement.currentPeriodEndsAt,
    })
    .from(schema.organizationEntitlement)
    .where(eq(schema.organizationEntitlement.organizationId, input.organizationId))
    .limit(1);

  return updated
    ? {
        ...updated,
        trialEndsAt: updated.trialEndsAt?.toISOString() ?? null,
        currentPeriodEndsAt: updated.currentPeriodEndsAt?.toISOString() ?? null,
      }
    : null;
}


export async function updateCommercialPlan(input: {
  planId: string;
  monthlyPriceCents: number;
  trialDays: number;
}) {
  const monthlyPriceCents = Math.max(0, Math.trunc(input.monthlyPriceCents));
  const trialDays = Math.max(0, Math.min(365, Math.trunc(input.trialDays)));
  const [updated] = await getDb()
    .update(schema.commercialPlan)
    .set({
      monthlyPriceCents,
      trialDays,
      updatedAt: new Date(),
    })
    .where(eq(schema.commercialPlan.id, input.planId))
    .returning({
      id: schema.commercialPlan.id,
      code: schema.commercialPlan.code,
      name: schema.commercialPlan.name,
      monthlyPriceCents: schema.commercialPlan.monthlyPriceCents,
      currency: schema.commercialPlan.currency,
      trialDays: schema.commercialPlan.trialDays,
      active: schema.commercialPlan.active,
    });
  if (!updated) throw new Error("plan_not_found");
  return updated;
}
