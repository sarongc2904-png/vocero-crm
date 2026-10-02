import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { runAgentTurn } from "@/server/ai/pipeline";

export async function runWizardAgentTest(
  organizationId: string,
  text: string
): Promise<{ conversationId: string; response: string | null }> {
  const db = getDb();
  const contactId = newId("contact");
  const conversationId = newId("conversation");
  const now = new Date();

  await db.insert(schema.contact).values({
    id: contactId,
    organizationId,
    phone: null,
    waIdentity: `wizard:${contactId}`,
    name: "Prueba de configuración",
    archivedAt: now,
  });
  await db.insert(schema.conversation).values({
    id: conversationId,
    organizationId,
    contactId,
    isTest: true,
    aiEnabled: true,
    lastInboundAt: now,
    lastMessageAt: now,
  });
  await db.insert(schema.message).values({
    id: newId("message"),
    organizationId,
    conversationId,
    direction: "in",
    type: "text",
    text,
    status: "delivered",
    waTimestamp: now,
  });

  await runAgentTurn(conversationId, organizationId);

  const rows = await db
    .select({ text: schema.message.text })
    .from(schema.message)
    .where(
      scoped(
        schema.message.organizationId,
        organizationId,
        eq(schema.message.conversationId, conversationId),
        eq(schema.message.direction, "out")
      )
    )
    .orderBy(desc(schema.message.createdAt))
    .limit(1);
  return { conversationId, response: rows[0]?.text ?? null };
}
