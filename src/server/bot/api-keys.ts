import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";

/**
 * Fase 1 — Claves del bot API, UNA POR ORGANIZACIÓN.
 *
 * Antes de esto, `/api/bot/*` autenticaba contra una sola `BOT_API_KEY` de
 * instancia, y resolvía la organización con `resolveInstanceOrg()` — "la
 * primera fila de `organization`". Con una sola empresa por instancia (el
 * diseño original) eso era inofensivo: no había ambigüedad posible. En
 * cuanto exista una segunda organización, deja de serlo: cualquier clave
 * hablaría siempre con los datos de la primera empresa creada.
 *
 * Aquí la clave EN SÍ determina la organización: no hay "instancia", hay
 * "quién trae qué clave". Se guarda el hash (sha256), nunca la clave en
 * claro — el mismo trato que un token de sesión.
 */

const KEY_BYTES = 32; // 256 bits, igual que BOT_API_KEY antes

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

/**
 * Genera una clave nueva para la organización, reemplazando la anterior si
 * había una (una sola vigente por organización — rotar es crear otra).
 * Devuelve la clave EN CLARO una sola vez: nadie puede volver a leerla
 * después, solo regenerarla.
 */
export async function issueBotApiKey(
  organizationId: string
): Promise<{ key: string; last4: string }> {
  const key = randomBytes(KEY_BYTES).toString("hex");
  const last4 = key.slice(-4);
  const db = getDb();
  await db
    .insert(schema.botApiKey)
    .values({
      id: newId("botApiKey"),
      organizationId,
      keyHash: hashKey(key),
      keyLast4: last4,
    })
    .onConflictDoUpdate({
      target: schema.botApiKey.organizationId,
      set: { keyHash: hashKey(key), keyLast4: last4, lastUsedAt: null },
    });
  return { key, last4 };
}

export type BotApiKeyInfo = { organizationId: string; last4: string } | null;

/** ¿Esta organización ya tiene una clave emitida? Para la UI de Ajustes. */
export async function getBotApiKeyInfo(
  organizationId: string
): Promise<{ last4: string; lastUsedAt: string | null } | null> {
  const db = getDb();
  const rows = await db
    .select({ keyLast4: schema.botApiKey.keyLast4, lastUsedAt: schema.botApiKey.lastUsedAt })
    .from(schema.botApiKey)
    .where(eq(schema.botApiKey.organizationId, organizationId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { last4: row.keyLast4, lastUsedAt: row.lastUsedAt?.toISOString() ?? null };
}

/**
 * Resuelve QUÉ organización trae una clave dada. `null` si la clave no
 * corresponde a nadie — el llamador responde 401 sin distinguir "no existe"
 * de "está mal escrita" (no hay nada útil que filtrar ahí).
 *
 * La comparación es por hash + lookup de índice único, no por igualdad de
 * cadenas en memoria: no hay un secreto en RAM contra el que medir tiempo de
 * comparación porque no se compara la clave en claro con nada, se busca su
 * hash. `timingSafeEqual` sigue aplicando sobre el hash calculado, por
 * disciplina — un sha256 ya difunde cualquier diferencia de entrada, pero
 * comparar con `===` seguiría siendo la costumbre incorrecta a imitar en
 * otro lado del código.
 */
export async function resolveOrgByApiKey(rawKey: string): Promise<string | null> {
  if (!rawKey || rawKey.length < 16) return null;
  const hash = hashKey(rawKey);
  const db = getDb();
  const rows = await db
    .select({ organizationId: schema.botApiKey.organizationId, keyHash: schema.botApiKey.keyHash, id: schema.botApiKey.id })
    .from(schema.botApiKey)
    .where(eq(schema.botApiKey.keyHash, hash))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  // El SELECT ya filtró por el hash exacto (índice único); esta comparación
  // es un cinturón extra, no la defensa principal.
  const a = Buffer.from(row.keyHash);
  const b = Buffer.from(hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  await db
    .update(schema.botApiKey)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.botApiKey.id, row.id))
    .catch(() => {
      // Actualizar "último uso" nunca debe tumbar una petición autenticada.
    });

  return row.organizationId;
}
