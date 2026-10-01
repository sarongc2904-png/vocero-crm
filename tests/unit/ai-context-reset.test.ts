import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("reinicio de contexto IA", () => {
  it("Reactivate IA abre una nueva sesión semántica sin borrar auditoría", () => {
    const queries = source("src/server/inbox/queries.ts");

    expect(queries).toContain("set.aiContextResetAt = now");
    expect(queries).toContain("schema.pendingAgendaAction");
    expect(queries).toContain("schema.agendaOfferCursor");
    expect(queries).toContain("schema.offeredSlot");
  });

  it("el reset del bot reutiliza la misma semántica de reactivación", () => {
    const reset = source("src/app/api/bot/reset/route.ts");

    expect(reset).toContain("updateConversation(organizationId, conv.id");
    expect(reset).toContain("reactivate: true");
  });

  it("el pipeline corta el historial en aiContextResetAt", () => {
    const pipeline = source("src/server/ai/pipeline.ts");

    expect(pipeline).toContain("conversation.aiContextResetAt");
    expect(pipeline).toContain(
      "gte(schema.message.createdAt, conversation.aiContextResetAt)"
    );
  });

  it("un saludo aislado no puede provocar handoff del modelo", () => {
    const pipeline = source("src/server/ai/pipeline.ts");

    expect(pipeline).toContain(
      'if (inboundText && isBareGreeting(inboundText))'
    );
    expect(pipeline).toContain("await deliverReply(conversation, safeGreeting)");
  });

  it("la migración añade el punto de corte sin borrar mensajes", () => {
    const migration = source("drizzle/0033_ai_context_reset.sql");

    expect(migration).toContain(
      'ALTER TABLE "conversation" ADD COLUMN "ai_context_reset_at" timestamp'
    );
    expect(migration).not.toMatch(/delete\s+from\s+"?message"?/i);
  });
});
