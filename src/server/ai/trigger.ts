import { scheduleAgentTurn } from "@/server/ai/pipeline";
import { isAiConfigured } from "@/lib/env";
import { hasCommercialAccess } from "@/server/commercial/entitlement";

/**
 * Punto de enganche tras ingestar un inbound REAL. La ingesta siempre se
 * conserva; el entitlement solo decide si se encola ejecución premium.
 */
export async function maybeRunAgentTurn(
  organizationId: string,
  conversationId: string
): Promise<void> {
  if (!isAiConfigured()) return;
  if (!(await hasCommercialAccess(organizationId))) return;
  await scheduleAgentTurn(organizationId, conversationId);
}
