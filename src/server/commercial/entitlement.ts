import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";

export type CommercialAccess = {
  status: "trial" | "active" | "past_due" | "suspended" | "cancelled";
  allowed: boolean;
  trialEndsAt: string | null;
  plan: {
    code: string;
    name: string;
    monthlyPriceCents: number;
    currency: string;
    trialDays: number;
  };
};

export function isCommerciallyAllowed(
  status: CommercialAccess["status"],
  trialEndsAt: Date | null,
  now = new Date()
) {
  return (
    status === "active" ||
    (status === "trial" &&
      Boolean(trialEndsAt) &&
      trialEndsAt!.getTime() > now.getTime())
  );
}

export async function getCommercialAccess(
  organizationId: string,
  now = new Date()
): Promise<CommercialAccess> {
  const rows = await getDb()
    .select({
      entitlement: schema.organizationEntitlement,
      plan: schema.commercialPlan,
    })
    .from(schema.organizationEntitlement)
    .innerJoin(
      schema.commercialPlan,
      eq(schema.organizationEntitlement.planId, schema.commercialPlan.id)
    )
    .where(
      scoped(
        schema.organizationEntitlement.organizationId,
        organizationId,
        eq(schema.commercialPlan.active, true)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("entitlement_not_configured");
  return {
    status: row.entitlement.status,
    allowed: isCommerciallyAllowed(
      row.entitlement.status,
      row.entitlement.trialEndsAt,
      now
    ),
    trialEndsAt: row.entitlement.trialEndsAt?.toISOString() ?? null,
    plan: {
      code: row.plan.code,
      name: row.plan.name,
      monthlyPriceCents: row.plan.monthlyPriceCents,
      currency: row.plan.currency,
      trialDays: row.plan.trialDays,
    },
  };
}

/**
 * Gate defensivo para procesos sin sesión (webhooks, workers, jobs).
 * Si el tenant no tiene entitlement válido o el lookup falla, se considera
 * bloqueado: los datos entrantes pueden persistirse, pero no se ejecutan
 * funciones premium ni envíos automáticos.
 */
export async function hasCommercialAccess(
  organizationId: string,
  now = new Date()
): Promise<boolean> {
  try {
    return (await getCommercialAccess(organizationId, now)).allowed;
  } catch {
    return false;
  }
}
