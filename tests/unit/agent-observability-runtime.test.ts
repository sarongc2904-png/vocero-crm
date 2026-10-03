import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const recorder = vi.hoisted(() => ({
  statements: [] as Array<{ text: string; values: unknown[] }>,
  sequence: 0,
}));

vi.mock("@/lib/db", () => {
  const execute = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    recorder.statements.push({
      text: strings.join("?").replace(/\s+/g, " ").trim(),
      values,
    });
    return [];
  };
  const sql = Object.assign(execute, {
    begin: async <T>(fn: (transaction: typeof execute) => Promise<T>) =>
      fn(execute),
  });
  return { getSql: () => sql };
});

vi.mock("@/lib/db/ids", () => ({
  newId: (kind: string) => `${kind}_${++recorder.sequence}`,
}));

import {
  OBSERVABLE_AGENT_ACTIONS,
  createAgentRun,
  finishAgentRun,
  recordAgentAction,
  recordAgentEvidence,
  sanitizeObservabilityError,
  sanitizeObservabilityValue,
  withAgentRun,
} from "@/server/ai/observability";

describe("Agent Observability v2", () => {
  beforeEach(() => {
    recorder.statements.length = 0;
    recorder.sequence = 0;
  });

  it("crea, enlaza acciones/evidencia y termina un run", async () => {
    const run = await createAgentRun({
      organizationId: "org_a",
      conversationId: "conv_a",
      inboundMessageId: "msg_in",
      provider: "mock",
      model: "mock-model",
    });

    await withAgentRun(run, async () => {
      await recordAgentAction({
        action: "reply",
        outboundMessageId: "msg_out",
        payload: { Authorization: "Bearer must-not-survive", safe: "ok" },
      });
      await recordAgentEvidence([
        {
          sourceType: "kb_entry",
          sourceId: "kb_1",
          snapshot: { answer: "Dato exacto", apiKey: "must-not-survive" },
          score: 7,
        },
      ]);
    });
    await finishAgentRun(run, { status: "completed" });

    expect(run).toMatchObject({
      runId: "agentRun_1",
      organizationId: "org_a",
      conversationId: "conv_a",
    });
    expect(recorder.statements.map((entry) => entry.text).join("\n")).toContain(
      "INSERT INTO agent_run"
    );
    expect(recorder.statements.map((entry) => entry.text).join("\n")).toContain(
      "INSERT INTO agent_action_event"
    );
    expect(recorder.statements.map((entry) => entry.text).join("\n")).toContain(
      "INSERT INTO agent_evidence"
    );
    const persisted = JSON.stringify(recorder.statements);
    expect(persisted).toContain("agentRun_1");
    expect(persisted).toContain("7");
    expect(persisted).not.toContain("must-not-survive");
    expect(persisted).toContain("[REDACTED]");
    expect(recorder.statements.at(-1)?.values).toContain("completed");
  });

  it("un run fallido persiste sólo el error sanitizado", async () => {
    const run = await createAgentRun({
      organizationId: "org_a",
      conversationId: "conv_a",
    });
    await finishAgentRun(run, {
      status: "failed",
      error: new Error("upstream Bearer secret.token.value"),
    });

    const last = recorder.statements.at(-1);
    expect(last?.values).toContain("failed");
    expect(JSON.stringify(last?.values)).not.toContain("secret.token.value");
    expect(JSON.stringify(last?.values)).toContain("[REDACTED]");
  });

  it("cubre todas las acciones ejecutables reales", () => {
    expect(OBSERVABLE_AGENT_ACTIONS).toEqual(
      expect.arrayContaining([
        "reply",
        "handoff",
        "update_lead",
        "move_stage",
        "offer_slots",
        "book_slot",
        "reschedule_slot",
        "cancel_booking",
      ])
    );
  });

  it("elimina secretos anidados y headers Authorization", () => {
    const clean = sanitizeObservabilityValue({
      accessToken: "tok_live_123",
      nested: {
        Authorization: "Bearer abc.def.ghi",
        password: "super-secret",
        safe: "visible",
      },
      tokenCipher: "ciphertext",
      tokenIv: "iv",
      tokenTag: "tag",
    });
    expect(clean).toEqual({
      accessToken: "[REDACTED]",
      nested: {
        Authorization: "[REDACTED]",
        password: "[REDACTED]",
        safe: "visible",
      },
      tokenCipher: "[REDACTED]",
      tokenIv: "[REDACTED]",
      tokenTag: "[REDACTED]",
    });
  });

  it("sanea errores antes de persistirlos", () => {
    expect(
      sanitizeObservabilityError(
        new Error("request failed Authorization: Bearer abc.def.ghi")
      )
    ).not.toContain("abc.def.ghi");
  });

  it("0036 crea runs, actions, evidence y FKs tenant-aware", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "drizzle/0036_agent_observability_v2.sql"),
      "utf8"
    );
    for (const table of ["agent_run", "agent_action_event", "agent_evidence"]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
    }
    expect(migration).toContain("agent_action_event_run_id_tenant_fk");
    expect(migration).toContain("agent_evidence_run_id_tenant_fk");
    expect(migration).toContain("agent_run_conversation_id_tenant_fk");
  });

  it("el pipeline registra evidencia y acciones en puntos reales", () => {
    const pipeline = readFileSync(
      resolve(process.cwd(), "src/server/ai/pipeline.ts"),
      "utf8"
    );
    expect(pipeline).toContain("createAgentRun");
    expect(pipeline).toContain("recordAgentEvidence");
    expect(pipeline).toContain('action: "move_stage"');
    expect(pipeline).toContain('action: "update_lead"');
    expect(pipeline).toContain('action: "cancel_booking"');
  });
});
