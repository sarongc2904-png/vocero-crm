import { eq } from "drizzle-orm";
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
  now?: Date;
}): Promise<void> {
  const db = getDb();
  const now = input.now ?? new Date();
  const values = {
    id: newId("pendingAgendaAction"),
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
    // Expirada: se descarta y se borra para que no pueda reutilizarse.
    await clearPendingAction(organizationId, conversationId);
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
