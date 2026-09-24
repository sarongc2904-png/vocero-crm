import { asc, eq, sql } from "drizzle-orm";
import { getAuth, runInternalSignup } from "@/lib/auth";
import { getDb, schema } from "@/lib/db";
import { createOrganizationForOwner } from "@/server/auth/organizations";
import { getOnboardingState } from "@/server/commercial/onboarding";

export const COMMERCIAL_ACTIONS = [
  "extend_trial",
  "activate",
  "suspend",
  "cancel",
  "reactivate",
  "change_plan",
] as const;

export type CommercialAdminAction = (typeof COMMERCIAL_ACTIONS)[number];

async function recordCommercialAudit(input: {
  actorUserId: string;
  action: string;
  organizationId?: string | null;
  planId?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
}) {
  await getDb().execute(sql`
    insert into commercial_admin_audit (
      id,
      actor_user_id,
      action,
      organization_id,
      plan_id,
      before_state,
      after_state,
      created_at
    ) values (
      ${`caa_${crypto.randomUUID()}`},
      ${input.actorUserId},
      ${input.action},
      ${input.organizationId ?? null},
      ${input.planId ?? null},
      ${JSON.stringify(input.beforeState ?? null)}::jsonb,
      ${JSON.stringify(input.afterState ?? null)}::jsonb,
      now()
    )
  `);
}

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

  return Promise.all(
    rows.map(async (row) => {
      const onboarding = await getOnboardingState(row.organizationId);
      const nextRequired =
        onboarding.steps.find(
          (step) => !step.complete && !step.optional && step.id !== "activation"
        ) ?? null;

      return {
        ...row,
        createdAt: row.createdAt.toISOString(),
        trialStartedAt: row.trialStartedAt?.toISOString() ?? null,
        trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
        currentPeriodEndsAt: row.currentPeriodEndsAt?.toISOString() ?? null,
        operationalStatus: onboarding.operationalStatus,
        requiredCompleted: onboarding.requiredCompleted,
        requiredTotal: onboarding.requiredTotal,
        nextRequiredStep: nextRequired?.label ?? null,
      };
    })
  );
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
  actorUserId: string;
}) {
  const db = getDb();
  const [entitlement] = await db
    .select()
    .from(schema.organizationEntitlement)
    .where(eq(schema.organizationEntitlement.organizationId, input.organizationId))
    .limit(1);
  if (!entitlement) throw new Error("entitlement_not_found");

  const now = new Date();
  const beforeState = {
    status: entitlement.status,
    planId: entitlement.planId,
    trialStartedAt: entitlement.trialStartedAt?.toISOString() ?? null,
    trialEndsAt: entitlement.trialEndsAt?.toISOString() ?? null,
    currentPeriodEndsAt: entitlement.currentPeriodEndsAt?.toISOString() ?? null,
    suspendedAt: entitlement.suspendedAt?.toISOString() ?? null,
    cancelledAt: entitlement.cancelledAt?.toISOString() ?? null,
  };

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

  const result = updated
    ? {
        ...updated,
        trialEndsAt: updated.trialEndsAt?.toISOString() ?? null,
        currentPeriodEndsAt: updated.currentPeriodEndsAt?.toISOString() ?? null,
      }
    : null;

  if (result) {
    await recordCommercialAudit({
      actorUserId: input.actorUserId,
      action: `account.${input.action}`,
      organizationId: input.organizationId,
      planId: result.planId,
      beforeState,
      afterState: result,
    });
  }

  return result;
}


export async function createCommercialClient(input: {
  businessName: string;
  ownerName: string;
  email: string;
  password: string;
  planId: string;
  trialDays?: number;
  actorUserId: string;
}) {
  const db = getDb();

  const [plan] = await db
    .select({
      id: schema.commercialPlan.id,
      trialDays: schema.commercialPlan.trialDays,
      active: schema.commercialPlan.active,
    })
    .from(schema.commercialPlan)
    .where(eq(schema.commercialPlan.id, input.planId))
    .limit(1);

  if (!plan || !plan.active) throw new Error("plan_not_found");

  const auth = getAuth();
  let userId: string;
  try {
    const result = await runInternalSignup(() =>
      auth.api.signUpEmail({
        body: {
          name: input.ownerName,
          email: input.email,
          password: input.password,
        },
      })
    );
    userId = result.user.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/exist|already|duplicate/i.test(message)) {
      throw new Error("email_already_exists");
    }
    throw error;
  }

  const organization = await createOrganizationForOwner(userId, input.businessName);
  const now = new Date();
  const trialDays = Math.max(
    0,
    Math.min(365, Math.trunc(input.trialDays ?? plan.trialDays))
  );
  const trialEndsAt = new Date(now.getTime() + trialDays * 86_400_000);

  await db
    .update(schema.organizationEntitlement)
    .set({
      planId: plan.id,
      status: trialDays > 0 ? "trial" : "active",
      trialStartedAt: trialDays > 0 ? now : null,
      trialEndsAt: trialDays > 0 ? trialEndsAt : null,
      suspendedAt: null,
      cancelledAt: null,
      updatedAt: now,
    })
    .where(
      eq(schema.organizationEntitlement.organizationId, organization.id)
    );

  const result = {
    organizationId: organization.id,
    organizationName: organization.name,
    organizationSlug: organization.slug,
    ownerUserId: userId,
    ownerName: input.ownerName,
    email: input.email,
    planId: plan.id,
    status: trialDays > 0 ? ("trial" as const) : ("active" as const),
    trialDays,
    trialEndsAt: trialDays > 0 ? trialEndsAt.toISOString() : null,
  };

  await recordCommercialAudit({
    actorUserId: input.actorUserId,
    action: "client.create",
    organizationId: organization.id,
    planId: plan.id,
    afterState: result,
  });

  return result;
}

export async function updateCommercialPlan(input: {
  planId: string;
  monthlyPriceCents: number;
  trialDays: number;
  actorUserId: string;
}) {
  const monthlyPriceCents = Math.max(0, Math.trunc(input.monthlyPriceCents));
  const trialDays = Math.max(0, Math.min(365, Math.trunc(input.trialDays)));
  const db = getDb();
  const [before] = await db
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
    .where(eq(schema.commercialPlan.id, input.planId))
    .limit(1);
  if (!before) throw new Error("plan_not_found");

  const [updated] = await db
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

  await recordCommercialAudit({
    actorUserId: input.actorUserId,
    action: "plan.update",
    planId: input.planId,
    beforeState: before,
    afterState: updated,
  });

  return updated;
}
