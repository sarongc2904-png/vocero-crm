import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";

/**
 * IA-3 — Cursor de expansión de disponibilidad.
 *
 * "otros horarios" mostraba siempre la misma ventana porque no había memoria de
 * lo ya enseñado. No se puede derivar de `offered_slot` (esa tabla guarda el
 * catálogo completo, no la ventana presentada), así que el estado es explícito:
 * una fila por conversación con el modo y el índice de ventana.
 *
 * Tenant-safe: toda lectura/escritura va con `scoped(...)`, y la fila es única
 * por conversación, que ya es de un solo tenant.
 */

export type OfferCursorMode = "next_day" | "morning" | "afternoon" | "weekend";

/** Cuánto vale un cursor. Pasado ese rato, la conversación vuelve a empezar. */
export const OFFER_CURSOR_TTL_MS = 60 * 60 * 1000;

/**
 * Devuelve el índice de ventana que toca mostrar para `mode` y AVANZA el cursor.
 *
 * - Sin fila, expirada, o de OTRO modo → `0` (primera ventana de ese criterio).
 *   Así cambiar de "otros horarios" a "más tarde"/"fin de semana" reajusta el
 *   scope de forma determinista en vez de arrastrar el cursor anterior.
 * - Misma fila y mismo modo → `cursor + 1` (ventana siguiente).
 */
export async function advanceOfferCursor(input: {
  organizationId: string;
  conversationId: string;
  mode: OfferCursorMode;
  now?: Date;
}): Promise<number> {
  const db = getDb();
  const now = input.now ?? new Date();

  const rows = await db
    .select()
    .from(schema.agendaOfferCursor)
    .where(
      scoped(
        schema.agendaOfferCursor.organizationId,
        input.organizationId,
        eq(schema.agendaOfferCursor.conversationId, input.conversationId)
      )
    )
    .limit(1);

  const row = rows[0];
  const usable =
    row !== undefined &&
    row.mode === input.mode &&
    row.expiresAt.getTime() > now.getTime();
  const cursor = usable ? row.cursor + 1 : 0;
  const expiresAt = new Date(now.getTime() + OFFER_CURSOR_TTL_MS);

  await db
    .insert(schema.agendaOfferCursor)
    .values({
      conversationId: input.conversationId,
      organizationId: input.organizationId,
      mode: input.mode,
      cursor,
      updatedAt: now,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: schema.agendaOfferCursor.conversationId,
      set: { mode: input.mode, cursor, updatedAt: now, expiresAt },
    });

  return cursor;
}

/** Una nueva oferta BASE vuelve a empezar por la primera ventana. */
export async function resetOfferCursor(
  organizationId: string,
  conversationId: string
): Promise<void> {
  const db = getDb();
  await db
    .delete(schema.agendaOfferCursor)
    .where(
      scoped(
        schema.agendaOfferCursor.organizationId,
        organizationId,
        eq(schema.agendaOfferCursor.conversationId, conversationId)
      )
    );
}
