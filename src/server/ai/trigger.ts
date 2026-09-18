import { scheduleAgentTurn } from "@/server/ai/pipeline";
import { isAiConfigured } from "@/lib/env";

/**
 * Punto de enganche tras ingestar un inbound REAL. Wave 3: scheduleAgentTurn
 * persiste el trabajo en Postgres; ya no depende de timers/Map en memoria.
 */
export async function maybeRunAgentTurn(
  conversationId: string
): Promise<void> {
  if (!isAiConfigured()) return;
  await scheduleAgentTurn(conversationId);
}
