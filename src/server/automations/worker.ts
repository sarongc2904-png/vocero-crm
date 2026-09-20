import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { isWindowOpen } from "@/server/inbox/window";
import { sendText } from "@/server/inbox/send";
import { sendTemplate } from "@/server/whatsapp/templates";
import {
  claimAutomation,
  finishAutomation,
  retryAutomation,
  type ClaimedAutomation,
} from "@/server/automations/queue";
import { hasCommercialAccess } from "@/server/commercial/entitlement";

const globalAutomation = globalThis as unknown as {
  __automationTimer?: ReturnType<typeof setInterval>;
  __automationRunning?: boolean;
};

async function execute(job: ClaimedAutomation) {
  if (!(await hasCommercialAccess(job.organizationId))) {
    await finishAutomation(job, "cancelled", "subscription_inactive");
    return;
  }

  if (!job.conversationId) {
    await finishAutomation(job, "failed", "conversation_required");
    return;
  }
  if (job.bookingId && job.kind === "appointment_reminder") {
    const bookings = await getDb()
      .select({ status: schema.booking.status })
      .from(schema.booking)
      .where(
        scoped(
          schema.booking.organizationId,
          job.organizationId,
          eq(schema.booking.id, job.bookingId)
        )
      )
      .limit(1);
    if (bookings[0]?.status !== "agendada") {
      await finishAutomation(job, "cancelled", "booking_not_active");
      return;
    }
  }
  const conversations = await getDb()
    .select({ lastInboundAt: schema.conversation.lastInboundAt })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        job.organizationId,
        eq(schema.conversation.id, job.conversationId)
      )
    )
    .limit(1);
  const conversation = conversations[0];
  if (!conversation) {
    await finishAutomation(job, "cancelled", "conversation_not_found");
    return;
  }

  const templateVariables = Array.isArray(job.payload?.templateVariables)
    ? job.payload.templateVariables.map(String)
    : [];
  if (isWindowOpen(conversation.lastInboundAt) && job.messageText) {
    await sendText({
      organizationId: job.organizationId,
      conversationId: job.conversationId,
      text: job.messageText,
    });
  } else if (job.templateId) {
    await sendTemplate({
      organizationId: job.organizationId,
      conversationId: job.conversationId,
      templateId: job.templateId,
      variables: templateVariables,
    });
  } else {
    await finishAutomation(job, "failed", "template_required_outside_window");
    return;
  }
  await finishAutomation(job, "completed");
}

async function drain() {
  if (globalAutomation.__automationRunning) return;
  globalAutomation.__automationRunning = true;
  try {
    for (let index = 0; index < 10; index += 1) {
      const job = await claimAutomation();
      if (!job) return;
      try {
        await execute(job);
      } catch (error) {
        const outcome = await retryAutomation(job, error);
        console.error(
          JSON.stringify({
            event: outcome === "failed" ? "automation.failed" : "automation.retry",
            organizationId: job.organizationId,
            jobId: job.id,
            kind: job.kind,
            attempts: job.attempts,
            error: String(error).slice(0, 500),
          })
        );
      }
    }
  } finally {
    globalAutomation.__automationRunning = false;
  }
}

export function startAutomationWorker() {
  if (globalAutomation.__automationTimer) return;
  void drain();
  const timer = setInterval(() => void drain(), 2_000);
  timer.unref?.();
  globalAutomation.__automationTimer = timer;
}
