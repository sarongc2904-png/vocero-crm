import { withOrgPermissions } from "@/lib/api";
import { getBotApiKeyInfo, issueBotApiKey } from "@/server/bot/api-keys";

export const dynamic = "force-dynamic";

/**
 * Fase 1 — gestión operativa de la credencial de `/api/bot/*` (una por
 * organización). Antes de esto, `issueBotApiKey()` existía pero no había
 * forma de emitirla ni rotarla salvo con un script: el aislamiento
 * multi-tenant no sirve de nada si nadie puede sacar su clave.
 */

export const GET = withOrgPermissions(["bot_api.manage"], async (session) => {
  const info = await getBotApiKeyInfo(session.organizationId);
  return Response.json({
    exists: info !== null,
    keyLast4: info?.last4 ?? null,
    lastUsedAt: info?.lastUsedAt ?? null,
  });
});

/**
 * Emite (primera vez) o rota (si ya existía) la clave — mismo camino: solo
 * puede haber una viva por organización, y `issueBotApiKey` invalida la
 * anterior en el mismo UPDATE. La clave cruda se devuelve UNA sola vez aquí;
 * nunca se guarda ni se puede volver a consultar.
 */
export const POST = withOrgPermissions(["bot_api.manage"], async (session) => {
  const { key, last4 } = await issueBotApiKey(session.organizationId);
  return Response.json({ key, keyLast4: last4 }, { status: 201 });
});
