import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { scheduleAutomation } from "@/server/automations/queue";

const scheduleSchema = z.object({
  ruleId: z.string().min(1),
  conversationId: z.string().min(1),
  dueAt: z.string().datetime(),
  idempotencyKey: z.string().trim().min(8).max(240),
  templateVariables: z.array(z.string().max(1024)).max(20).default([]),
});

export const POST = withOrgPermissions(
  ["conversations.reply"],
  async (session, request: Request) => {
    const body = await parseBody(request, scheduleSchema);
    if (!body.ok) return body.response;
    const rules = await getDb()
      .select()
      .from(schema.automationRule)
      .where(
        scoped(
          schema.automationRule.organizationId,
          session.organizationId,
          eq(schema.automationRule.id, body.data.ruleId),
          eq(schema.automationRule.enabled, true)
        )
      )
      .limit(1);
    const rule = rules[0];
    if (!rule) return apiError(404, "not_found", "Automatización no encontrada");
    const scheduled = await scheduleAutomation({
      organizationId: session.organizationId,
      ruleId: rule.id,
      kind: rule.kind,
      conversationId: body.data.conversationId,
      dueAt: new Date(body.data.dueAt),
      idempotencyKey: body.data.idempotencyKey,
      messageText: rule.messageText,
      templateId: rule.templateId,
      payload: { templateVariables: body.data.templateVariables },
    });
    if (!scheduled) {
      return apiError(404, "not_found", "Conversación no encontrada");
    }
    return Response.json({ scheduled: true }, { status: 201 });
  }
);
