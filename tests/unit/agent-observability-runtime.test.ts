import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OBSERVABLE_AGENT_ACTIONS,
  sanitizeObservabilityError,
  sanitizeObservabilityValue,
} from "@/server/ai/observability";

describe("Agent Observability v2", () => {
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
