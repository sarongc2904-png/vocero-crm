import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("Wave 1 - tenant scope audit", () => {
  it("runAgentTurn acepta el tenant esperado y scopea historial", () => {
    const text = source("src/server/ai/pipeline.ts");
    expect(text).toContain("expectedOrganizationId?: string");
    expect(text).toContain("schema.conversation.organizationId,\n            expectedOrganizationId");
    expect(text).toContain("schema.message.organizationId,\n        organizationId");
  });

  it("handoff, sandbox outbound y notas exigen organizationId", () => {
    const text = source("src/server/ai/pipeline.ts");
    const scopedConversationWrites = text.match(
      /scoped\(\s*schema\.conversation\.organizationId,/g
    );
    const scopedContactUses = text.match(
      /scoped\(\s*schema\.contact\.organizationId,/g
    );

    // lookup con expected org + persistTestOutbound + applyHandoff
    expect(scopedConversationWrites?.length ?? 0).toBeGreaterThanOrEqual(3);
    // appendLeadNote: SELECT + UPDATE
    expect(scopedContactUses?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("runner no hace updates por id desnudo en runs/cases/conversaciones", () => {
    const text = source("src/server/lab/runner.ts");

    expect(text).not.toMatch(
      /\.where\(eq\(schema\.agentTestCase\.(?:id|runId),/
    );
    expect(text).not.toMatch(/\.where\(eq\(schema\.agentTestRun\.id,/);
    expect(text).not.toMatch(/\.where\(eq\(schema\.conversation\.id,/);
    expect(text).not.toMatch(/\.where\(eq\(schema\.message\.conversationId,/);
    expect(text).toContain("await runAgentTurn(convId, organizationId)");
  });

  it("action trace se persiste con clave tenant + test case", () => {
    const migration = source("drizzle/0017_agent_lab_wave1_trace.sql");
    expect(migration).toContain('"organization_id"');
    expect(migration).toContain('"test_case_id"');
    expect(migration).toContain(
      '("organization_id", "test_case_id")'
    );
  });
});
