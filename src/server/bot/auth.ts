import { apiError } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { resolveOrgByApiKey } from "@/server/bot/api-keys";

/**
 * Autenticación de la API de servicio `/api/bot/*`.
 *
 * Fase 1 — reemplaza el par `requireBotKey()` + `resolveInstanceOrg()`. Antes,
 * la clave era una sola por INSTANCIA (`process.env.BOT_API_KEY`) y la
 * organización se resolvía por separado tomando "la primera fila de
 * `organization`" — con una sola empresa por instancia eso no importaba, pero
 * era una fuga de aislamiento esperando a que existiera una segunda.
 *
 * Ahora la CLAVE determina la organización: cada empresa tiene la suya
 * (`bot_api_key`, una fila por organización), y quien la trae solo puede ver
 * y tocar los datos de esa organización — no hay "instancia" que resolver.
 */
export type BotAuthResult =
  | { ok: true; organizationId: string }
  | { ok: false; response: Response };

export async function authenticateBotRequest(req: Request): Promise<BotAuthResult> {
  const rl = checkRateLimit("bot-api", { windowMs: 60_000, max: 600 });
  if (!rl.allowed) {
    return { ok: false, response: apiError(429, "rate_limited", "Demasiadas solicitudes") };
  }

  const provided = req.headers.get("x-api-key");
  if (!provided) {
    return { ok: false, response: apiError(401, "unauthorized", "No autorizado") };
  }

  const organizationId = await resolveOrgByApiKey(provided);
  if (!organizationId) {
    return { ok: false, response: apiError(401, "unauthorized", "No autorizado") };
  }

  return { ok: true, organizationId };
}
