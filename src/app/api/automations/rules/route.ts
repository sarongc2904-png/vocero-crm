import { asc } from "drizzle-orm";
import { z } from "zod";
import { parseBody, withOrgPermissions } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";

export const dynamic = "force-dynamic";

const ruleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum([
    "follow_up",
    "appointment_reminder",
    "review_request",
    "reactivation",
  ]),
  enabled: z.boolean().default(false),
  delayMinutes: z.number().int().min(0).max(525_600),
  messageText: z.string().trim().max(4096).nullish(),
  templateId: z.string().min(1).nullish(),
  config: z.record(z.string(), z.unknown()).nullish(),
});

export const GET = withOrgPermissions(["settings.read"], async (session) => {
  const rules = await getDb()
    .select()
    .from(schema.automationRule)
    .where(scoped(schema.automationRule.organizationId, session.organizationId))
    .orderBy(asc(schema.automationRule.kind), asc(schema.automationRule.name));
  return Response.json({ rules });
});

export const POST = withOrgPermissions(
  ["settings.update"],
  async (session, request: Request) => {
    const body = await parseBody(request, ruleSchema);
    if (!body.ok) return body.response;
    const rows = await getDb()
      .insert(schema.automationRule)
      .values({
        id: newId("automationRule"),
        organizationId: session.organizationId,
        ...body.data,
        messageText: body.data.messageText || null,
        templateId: body.data.templateId ?? null,
        config: body.data.config ?? null,
      })
      .returning();
    return Response.json({ rule: rows[0] }, { status: 201 });
  }
);
