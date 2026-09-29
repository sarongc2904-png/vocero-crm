import { withOrgPermissions } from "@/lib/api";
import { auditPrivilegedAction } from "@/server/auth/audit";
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
  // SEC-V6b: la clave da control total de `/api/bot/*` del tenant y al rotarla
  // se invalida la anterior — el rastro de quién y cuándo es obligatorio. Se
  // audita solo el last4; la clave cruda nunca toca el log.
  await auditPrivilegedAction(session, {
    action: "bot_api.key.rotate",
    targetType: "bot_api_key",
    targetId: session.organizationId,
    metadata: { keyLast4: last4 },
  });
  return Response.json({ key, keyLast4: last4 }, { status: 201 });
});
