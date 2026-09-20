import { z } from "zod";
import { apiError, parseBody, withAuthOptions } from "@/lib/api";
import {
  COMMERCIAL_ACTIONS,
  listCommercialAccounts,
  listCommercialPlans,
  updateCommercialAccount,
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

const updateSchema = z.object({
  organizationId: z.string().min(1),
  action: z.enum(COMMERCIAL_ACTIONS),
  days: z.number().int().min(1).max(365).optional(),
  planId: z.string().min(1).optional(),
});

export const PATCH = withAuthOptions(
  { allowBlockedCommercialAccess: true },
  async (session, req: Request) => {
    const denied = requireSuperadmin(session.isSuperadmin);
    if (denied) return denied;
    const body = await parseBody(req, updateSchema);
    if (!body.ok) return body.response;

    try {
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
