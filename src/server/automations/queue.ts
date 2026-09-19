import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, getSql, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";

export type AutomationKind =
  | "follow_up"
  | "appointment_reminder"
  | "review_request"
  | "reactivation";

export type ClaimedAutomation = {
  id: string;
  organizationId: string;
  kind: AutomationKind;
  conversationId: string | null;
  bookingId: string | null;
  messageText: string | null;
  templateId: string | null;
  payload: Record<string, unknown> | null;
  attempts: number;
};

export async function scheduleAutomation(input: {
  organizationId: string;
  ruleId?: string | null;
  kind: AutomationKind;
  conversationId: string;
  contactId?: string | null;
  bookingId?: string | null;
  dueAt: Date;
  idempotencyKey: string;
  messageText?: string | null;
  templateId?: string | null;
  payload?: Record<string, unknown> | null;
}) {
  if (!schema.scheduledAutomation) return false;
  const db = getDb();
  const conversations = await db
    .select({ id: schema.conversation.id, contactId: schema.conversation.contactId })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        input.organizationId,
        eq(schema.conversation.id, input.conversationId)
      )
    )
    .limit(1);
  const conversation = conversations[0];
  if (!conversation) return false;
  if (input.bookingId) {
    const bookings = await db
      .select({ id: schema.booking.id })
      .from(schema.booking)
      .where(
        scoped(
          schema.booking.organizationId,
          input.organizationId,
          eq(schema.booking.id, input.bookingId)
        )
      )
      .limit(1);
    if (!bookings[0]) return false;
  }
  await db
    .insert(schema.scheduledAutomation)
    .values({
      id: newId("scheduledAutomation"),
      organizationId: input.organizationId,
      ruleId: input.ruleId ?? null,
      kind: input.kind,
      status: "scheduled",
      conversationId: input.conversationId,
      contactId: input.contactId ?? conversation.contactId,
      bookingId: input.bookingId ?? null,
      dueAt: input.dueAt,
      idempotencyKey: input.idempotencyKey,
      messageText: input.messageText ?? null,
      templateId: input.templateId ?? null,
      payload: input.payload ?? null,
    })
    .onConflictDoNothing({
      target: [
        schema.scheduledAutomation.organizationId,
        schema.scheduledAutomation.idempotencyKey,
      ],
    });
  return true;
}

export async function scheduleBookingAutomations(input: {
  organizationId: string;
  bookingId: string;
  conversationId: string | null;
  scheduledAt: Date;
}) {
  if (!schema.automationRule || !schema.scheduledAutomation) return;
  if (!input.conversationId) return;
  const rules = await getDb()
    .select()
    .from(schema.automationRule)
    .where(
      scoped(
        schema.automationRule.organizationId,
        input.organizationId,
        and(
          eq(schema.automationRule.enabled, true),
          eq(schema.automationRule.kind, "appointment_reminder")
        )
      )
    )
    .orderBy(asc(schema.automationRule.delayMinutes));
  for (const rule of rules) {
    const dueAt = new Date(input.scheduledAt.getTime() - rule.delayMinutes * 60_000);
    if (dueAt <= new Date()) continue;
    await scheduleAutomation({
      organizationId: input.organizationId,
      ruleId: rule.id,
      kind: "appointment_reminder",
      conversationId: input.conversationId,
      bookingId: input.bookingId,
      dueAt,
      idempotencyKey: `${rule.id}:${input.bookingId}:${input.scheduledAt.toISOString()}`,
      messageText: rule.messageText,
      templateId: rule.templateId,
    });
  }
}

export async function cancelBookingAutomations(
  organizationId: string,
  bookingId: string
) {
  if (!schema.scheduledAutomation) return;
  await getDb()
    .update(schema.scheduledAutomation)
    .set({ status: "cancelled", leaseUntil: null, updatedAt: new Date() })
    .where(
      scoped(
        schema.scheduledAutomation.organizationId,
        organizationId,
        and(
          eq(schema.scheduledAutomation.bookingId, bookingId),
          inArray(schema.scheduledAutomation.status, ["scheduled", "pending", "processing"])
        )
      )
    );
}

export async function scheduleReviewRequests(input: {
  organizationId: string;
  bookingId: string;
  conversationId: string | null;
}) {
  if (!schema.automationRule || !schema.scheduledAutomation) return;
  if (!input.conversationId) return;
  const rules = await getDb()
    .select()
    .from(schema.automationRule)
    .where(
      scoped(
        schema.automationRule.organizationId,
        input.organizationId,
        and(
          eq(schema.automationRule.enabled, true),
          eq(schema.automationRule.kind, "review_request")
        )
      )
    );
  for (const rule of rules) {
    await scheduleAutomation({
      organizationId: input.organizationId,
      ruleId: rule.id,
      kind: "review_request",
      conversationId: input.conversationId,
      bookingId: input.bookingId,
      dueAt: new Date(Date.now() + rule.delayMinutes * 60_000),
      idempotencyKey: `${rule.id}:${input.bookingId}:review`,
      messageText: rule.messageText,
      templateId: rule.templateId,
      payload: rule.config as Record<string, unknown> | null,
    });
  }
}

export async function claimAutomation(): Promise<ClaimedAutomation | null> {
  const rows = await getSql()`
    with candidate as (
      select id from scheduled_automation
      where status in ('scheduled','pending')
        and due_at <= now()
        and (lease_until is null or lease_until < now())
      order by due_at, created_at
      for update skip locked
      limit 1
    )
    update scheduled_automation a
    set status = 'processing', lease_until = now() + interval '10 minutes',
        attempts = attempts + 1, updated_at = now()
    from candidate where a.id = candidate.id
    returning a.id, a.organization_id, a.kind, a.conversation_id, a.booking_id,
      a.message_text, a.template_id, a.payload, a.attempts
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    kind: row.kind as AutomationKind,
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    bookingId: row.booking_id ? String(row.booking_id) : null,
    messageText: row.message_text ? String(row.message_text) : null,
    templateId: row.template_id ? String(row.template_id) : null,
    payload: (row.payload as Record<string, unknown> | null) ?? null,
    attempts: Number(row.attempts),
  };
}

export async function finishAutomation(
  job: ClaimedAutomation,
  status: "completed" | "cancelled" | "failed",
  error?: string
) {
  await getSql()`
    update scheduled_automation
    set status = ${status}, lease_until = null,
        completed_at = case when ${status} = 'completed' then now() else completed_at end,
        last_error = ${error?.slice(0, 2000) ?? null}, updated_at = now()
    where id = ${job.id} and organization_id = ${job.organizationId}
  `;
}

export async function retryAutomation(job: ClaimedAutomation, error: unknown) {
  if (job.attempts >= 5) {
    await finishAutomation(job, "failed", String(error));
    return "failed" as const;
  }
  await getSql()`
    update scheduled_automation
    set status = 'pending', lease_until = null,
        due_at = now() + make_interval(mins => ${Math.min(60, job.attempts * 5)}),
        last_error = ${String(error).slice(0, 2000)}, updated_at = now()
    where id = ${job.id} and organization_id = ${job.organizationId}
  `;
  return "retry" as const;
}
