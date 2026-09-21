import { z } from "zod";
import { apiError, parseBody, withAuthOptions } from "@/lib/api";
import {
  COMMERCIAL_ACTIONS,
  createCommercialClient,
  listCommercialAccounts,
  listCommercialPlans,
  updateCommercialAccount,
  updateCommercialPlan,
} from "@/server/commercial/admin";

export const dynamic = "force-dynamic";

function requireSuperadmin(isSuperadmin: boolean) {
  return isSuperadmin
    ? null
    : apiError(403, "forbidden", "Esta operación requiere superadmin");
}

export const GET = withAuthOptions(
  { allowBlockedCommercialAccess: true },
  async (session) => {
    const denied = requireSuperadmin(session.isSuperadmin);
    if (denied) return denied;
    const [accounts, plans] = await Promise.all([
      listCommercialAccounts(),
      listCommercialPlans(),
    ]);
    return Response.json({ accounts, plans });
  }
);

const accountUpdateSchema = z.object({
  target: z.literal("account").default("account"),
  organizationId: z.string().min(1),
  action: z.enum(COMMERCIAL_ACTIONS),
  days: z.number().int().min(1).max(365).optional(),
  planId: z.string().min(1).optional(),
});

const planUpdateSchema = z.object({
  target: z.literal("plan"),
  planId: z.string().min(1),
  monthlyPriceCents: z.number().int().min(0).max(100_000_000),
  trialDays: z.number().int().min(0).max(365),
});

const updateSchema = z.union([accountUpdateSchema, planUpdateSchema]);

const createClientSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().min(2).max(120),
  email: z.string().trim().email(),
  password: z.string().min(8).max(128),
  planId: z.string().trim().min(1),
  trialDays: z.number().int().min(0).max(365).optional(),
});

export const POST = withAuthOptions(
  { allowBlockedCommercialAccess: true },
  async (session, req: Request) => {
    const denied = requireSuperadmin(session.isSuperadmin);
    if (denied) return denied;

    const body = await parseBody(req, createClientSchema);
    if (!body.ok) return body.response;

    try {
      const client = await createCommercialClient(body.data);
      return Response.json({ client }, { status: 201 });
    } catch (error) {
      const code =
        error instanceof Error ? error.message : "client_create_failed";
      if (code === "email_already_exists") {
        return apiError(
          409,
          code,
          "Ya existe una cuenta con ese correo"
        );
      }
      if (code === "plan_not_found") {
        return apiError(422, code, "El plan indicado no es válido");
      }
      throw error;
    }
  }
);

export const PATCH = withAuthOptions(
  { allowBlockedCommercialAccess: true },
  async (session, req: Request) => {
    const denied = requireSuperadmin(session.isSuperadmin);
    if (denied) return denied;
    const body = await parseBody(req, updateSchema);
    if (!body.ok) return body.response;

    try {
      if (body.data.target === "plan") {
        const plan = await updateCommercialPlan(body.data);
        return Response.json({ plan });
      }

      const account = await updateCommercialAccount(body.data);
      if (!account) {
        return apiError(404, "not_found", "No se encontró la cuenta comercial");
      }
      return Response.json({ account });
    } catch (error) {
      const code = error instanceof Error ? error.message : "commercial_update_failed";
      if (code === "entitlement_not_found") {
        return apiError(404, "entitlement_not_found", "La organización no tiene entitlement");
      }
      if (code === "plan_required" || code === "plan_not_found") {
        return apiError(422, code, "El plan indicado no es válido");
      }
      throw error;
    }
  }
);
