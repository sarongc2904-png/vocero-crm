import { authenticateBotRequest } from "@/server/bot/auth";
import { quotesDisabledResponse, quotesEnabled } from "@/server/quotes/flag";

export type QuotesBotGate = { organizationId: string } | { response: Response };

/**
 * Puerta única de `/api/bot/catalog` y `/api/bot/quotes*`.
 *
 * La bandera va PRIMERO: apagada, la superficie no existe (404) ni siquiera
 * para quien trae una key válida, y no se gasta una consulta en resolverla.
 * El `organizationId` sale SOLO de la API key; ningún body ni query lo elige.
 */
export async function guardQuotesBot(req: Request): Promise<QuotesBotGate> {
  if (!quotesEnabled()) return { response: quotesDisabledResponse() };
  const auth = await authenticateBotRequest(req);
  if (!auth.ok) return { response: auth.response };
  return { organizationId: auth.organizationId };
}
