import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { describeSendError } from "@/lib/meta/send-errors";
import { publish } from "@/server/events/bus";
import type { WebhookStatus } from "@/server/inbox/webhook";

/** Orden monotónico de estados: nunca degradar (un delivered tardío no pisa read). */
const STATUS_RANK: Record<string, number> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

type MessageStatus = "pending" | "sent" | "delivered" | "read" | "failed";

export function isUpgrade(current: string, next: string): boolean {
  return upgradeableStatuses(next).includes(current as MessageStatus);
}

/**
 * Estados desde los que `next` puede aplicarse. Esta lista viaja también al
 * WHERE del UPDATE: PostgreSQL vuelve a evaluar el predicado después de
 * esperar un lock concurrente y evita que un delivered tardío pise read.
 */
export function upgradeableStatuses(next: string): MessageStatus[] {
  if (next === "failed") return ["pending", "sent", "delivered", "read"];
  const nextRank = STATUS_RANK[next];
  if (nextRank === undefined) return [];
  return (Object.entries(STATUS_RANK) as [MessageStatus, number][])
    .filter(([, rank]) => rank < nextRank)
    .map(([status]) => status);
}

export async function applyStatusUpdate(
  organizationId: string,
  status: WebhookStatus
): Promise<void> {
  const next = status.status;
  if (!(next in STATUS_RANK) && next !== "failed") return; // estado desconocido

  const allowedCurrent = upgradeableStatuses(next);
  if (allowedCurrent.length === 0) return;

  const failure = status.errors?.[0];
  const error =
    next === "failed"
      ? describeSendError(failure?.code, failure?.message ?? failure?.title)
      : null;

  const updated = await getDb()
    .update(schema.message)
    .set({ status: next as MessageStatus, error })
    .where(
      and(
        eq(schema.message.organizationId, organizationId),
        eq(schema.message.waMessageId, status.id),
        inArray(schema.message.status, allowedCurrent)
      )
    )
    .returning({
      id: schema.message.id,
      conversationId: schema.message.conversationId,
    });
  const msg = updated[0];
  if (!msg) return;

  publish(organizationId, {
    type: "message.status",
    data: {
      conversationId: msg.conversationId,
      messageId: msg.id,
      status: next,
      // Sin esto el operador ve el triángulo de fallo pero nunca el motivo.
      error,
    },
  });
}
