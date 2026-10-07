import { eq, gt, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";

/**
 * IA-1 / IA-W1 / IA-W2 — Confirmación pendiente de una acción de agenda.
 *
 * El estado vive en el backend, nunca en el modelo: una acción destructiva o
 * una selección solo se ejecuta contra una fila vigente de esta tabla, ligada a
 * la conversación y a la organización. Sin fila (o con la fila expirada) una
 * confirmación no hace nada; una confirmación vieja jamás puede ejecutar una
 * acción nueva porque cada acción reemplaza la anterior.
 *
 * Además, la pendiente se liga a la PREGUNTA que la creó: su `id` es el id del
 * mensaje saliente que pidió la confirmación (no hace falta otra columna). Solo
 * es ejecutable mientras esa pregunta siga siendo el último mensaje saliente de
 * la conversación: si después escribió un operador o el agente respondió otra
 * cosa, el "sí" del cliente ya no contesta a esa pregunta.
 */

export type AgendaPendingKind = "book" | "reschedule" | "cancel";

export type PendingAgendaAction = {
  id: string;
  action: AgendaPendingKind;
  bookingId: string | null;
  startUtc: string | null;
  serviceId: string | null;
  professionalId: string | null;
  expiresAt: Date;
};

/** Cuánto vale una confirmación pendiente. */
export const PENDING_TTL_MS = 30 * 60 * 1000;

export async function setPendingAction(input: {
  organizationId: string;
  conversationId: string;
  action: AgendaPendingKind;
  bookingId?: string | null;
  startUtc?: string | null;
  serviceId?: string | null;
  professionalId?: string | null;
  /**
   * Id del mensaje saliente con la pregunta de confirmación. Sin él la
   * pendiente nunca es ejecutable (solo sirve para recordar una elección en
   * curso, p. ej. "¿cuál de tus citas?").
   */
  questionMessageId?: string | null;
  now?: Date;
}): Promise<void> {
  const db = getDb();
  const now = input.now ?? new Date();
  const values = {
    /**
     * OJO — la columna `id` de `pending_agenda_action` guarda el ID DEL MENSAJE
     * de la pregunta de confirmación (`message.id`), no un id propio de la
     * fila: así la pendiente queda ligada a su pregunta sin cambiar el esquema.
     * `consumePendingAction` lo compara con el último mensaje saliente. Nada más
     * debe usar este valor como id de fila (la fila se busca siempre por
     * conversación). Sin pregunta, el id es uno propio (`paa_…`) que no
     * coincide con ningún mensaje: esa pendiente nunca es ejecutable.
     *
     * Deuda técnica (docs/agenda-confirmacion-pendientes.md): mover esto a una
     * columna `question_message_id` en una migración futura que requiere
     * autorización.
     */
    id: input.questionMessageId ?? newId("pendingAgendaAction"),
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    action: input.action,
    bookingId: input.bookingId ?? null,
    startUtc: input.startUtc ? new Date(input.startUtc) : null,
    serviceId: input.serviceId ?? null,
    professionalId: input.professionalId ?? null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + PENDING_TTL_MS),
  };

  // Una sola acción pendiente por conversación: la última reemplaza a la
  // anterior, así una confirmación nunca puede ejecutar la acción vieja.
  await db
    .insert(schema.pendingAgendaAction)
    .values(values)
    .onConflictDoUpdate({
      target: schema.pendingAgendaAction.conversationId,
      set: {
        id: values.id,
        action: values.action,
        bookingId: values.bookingId,
        startUtc: values.startUtc,
        serviceId: values.serviceId,
        professionalId: values.professionalId,
        createdAt: values.createdAt,
        expiresAt: values.expiresAt,
      },
    });
}

export async function getPendingAction(
  organizationId: string,
  conversationId: string,
  now: Date = new Date()
): Promise<PendingAgendaAction | null> {
  return readPendingAction(organizationId, conversationId, now, true);
}

/**
 * Variante de solo lectura para simulaciones y diagnósticos. Una acción
 * expirada se trata como inexistente, pero no se elimina: shadow mode nunca
 * debe mutar estado operacional.
 */
export async function peekPendingAction(
  organizationId: string,
  conversationId: string,
  now: Date = new Date()
): Promise<PendingAgendaAction | null> {
  return readPendingAction(organizationId, conversationId, now, false);
}

async function readPendingAction(
  organizationId: string,
  conversationId: string,
  now: Date,
  clearExpired: boolean
): Promise<PendingAgendaAction | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.pendingAgendaAction)
    .where(
      scoped(
        schema.pendingAgendaAction.organizationId,
        organizationId,
        eq(schema.pendingAgendaAction.conversationId, conversationId)
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  if (row.expiresAt.getTime() <= now.getTime()) {
    // El flujo productivo limpia; shadow mode solo observa.
    if (clearExpired) {
      await clearPendingAction(organizationId, conversationId);
    }
    return null;
  }

  return {
    id: row.id,
    action: row.action as AgendaPendingKind,
    bookingId: row.bookingId,
    startUtc: row.startUtc ? row.startUtc.toISOString() : null,
    serviceId: row.serviceId,
    professionalId: row.professionalId,
    expiresAt: row.expiresAt,
  };
}

/**
 * Toma la acción pendiente EJECUTABLE y la borra en una sola sentencia
 * (`DELETE … RETURNING`). Es la única puerta para ejecutar una acción de
 * agenda: dos confirmaciones concurrentes no pueden recibir la misma fila.
 *
 * Ejecutable = todo a la vez, dentro del mismo WHERE:
 * - vigente (`expires_at > ahora`);
 * - ligada al ÚLTIMO mensaje saliente de la conversación, sea del agente o de
 *   un operador (su id es el de la pregunta que la creó), sin ningún otro
 *   saliente posterior ni con el mismo instante;
 * - sin handoff activo ni reinicio de sesión desde que se creó;
 * - cancelar y reprogramar guardan la cita exacta (`booking_id`).
 */
export async function consumePendingAction(
  organizationId: string,
  conversationId: string,
  now: Date = new Date()
): Promise<PendingAgendaAction | null> {
  const db = getDb();
  const rows = await db
    .delete(schema.pendingAgendaAction)
    .where(
      scoped(
        schema.pendingAgendaAction.organizationId,
        organizationId,
        eq(schema.pendingAgendaAction.conversationId, conversationId),
        gt(schema.pendingAgendaAction.expiresAt, now),
        // La pregunta (cuyo id ES el id de la pendiente) existe y ningún otro
        // saliente es posterior O SIMULTÁNEO: con dos mensajes en el mismo
        // instante no se sabe cuál vio el cliente al final, y ante la duda no
        // se ejecuta.
        sql`exists (select 1 from ${schema.message} as q where q."id" = ${schema.pendingAgendaAction.id} and q."organization_id" = ${organizationId} and q."conversation_id" = ${conversationId} and q."direction" = 'out' and not exists (select 1 from ${schema.message} as o where o."organization_id" = ${organizationId} and o."conversation_id" = ${conversationId} and o."direction" = 'out' and o."id" <> q."id" and o."created_at" >= q."created_at"))`,
        sql`exists (select 1 from ${schema.conversation} where ${schema.conversation.organizationId} = ${organizationId} and ${schema.conversation.id} = ${conversationId} and ${schema.conversation.handoffAt} is null and (${schema.conversation.aiContextResetAt} is null or ${schema.conversation.aiContextResetAt} < ${schema.pendingAgendaAction.createdAt}))`,
        sql`(${schema.pendingAgendaAction.action} = 'book' or ${schema.pendingAgendaAction.bookingId} is not null)`
      )
    )
    .returning();

  return executablePending(rows[0], now);
}

/**
 * La fila que devolvió el DELETE, solo si de verdad es ejecutable. El WHERE ya
 * excluye lo expirado y lo que no trae su cita; se comprueba otra vez por
 * defensa (y las pruebas del pipeline la ejercitan sin base de datos).
 */
export function executablePending(
  row: typeof schema.pendingAgendaAction.$inferSelect | undefined,
  now: Date
): PendingAgendaAction | null {
  if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
  if (row.action !== "book" && !row.bookingId) return null;
  return {
    id: row.id,
    action: row.action as AgendaPendingKind,
    bookingId: row.bookingId,
    startUtc: row.startUtc ? row.startUtc.toISOString() : null,
    serviceId: row.serviceId,
    professionalId: row.professionalId,
    expiresAt: row.expiresAt,
  };
}

export async function clearPendingAction(
  organizationId: string,
  conversationId: string
): Promise<void> {
  const db = getDb();
  await db
    .delete(schema.pendingAgendaAction)
    .where(
      scoped(
        schema.pendingAgendaAction.organizationId,
        organizationId,
        eq(schema.pendingAgendaAction.conversationId, conversationId)
      )
    );
}
