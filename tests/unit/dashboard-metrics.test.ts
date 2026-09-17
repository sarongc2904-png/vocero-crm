import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  summarizeStages,
  type DashboardStageMetric,
} from "../../src/server/dashboard/metrics";

function stage(
  id: string,
  position: number,
  kind: DashboardStageMetric["kind"],
  leads: number,
  amountCents: number,
  knownAmounts: number
): DashboardStageMetric {
  return {
    id,
    name: id,
    kind,
    position,
    leads,
    amountCents,
    knownAmounts,
  };
}

describe("dashboard metrics contract", () => {
  it("no convierte monto desconocido en cero", () => {
    const result = summarizeStages([
      stage("nuevo", 0, "open", 4, 0, 0),
      stage("cliente", 1, "won", 1, 50000, 1),
    ]);

    expect(result.pipelineValueCents).toBeNull();
    expect(result.knownAmounts).toBe(0);
  });

  it("distingue un monto conocido de cero de un monto desconocido", () => {
    const result = summarizeStages([
      stage("nuevo", 0, "open", 2, 0, 1),
      stage("cliente", 1, "won", 0, 0, 0),
    ]);

    expect(result.pipelineValueCents).toBe(0);
    expect(result.knownAmounts).toBe(1);
  });

  it("usa la primera etapa abierta como leads nuevos y separa won/lost", () => {
    const result = summarizeStages([
      stage("nuevo", 0, "open", 7, 10000, 1),
      stage("seguimiento", 1, "open", 3, 20000, 2),
      stage("cliente", 2, "won", 2, 50000, 2),
      stage("perdido", 3, "lost", 4, 0, 0),
    ]);

    expect(result.totalLeads).toBe(16);
    expect(result.newLeads).toBe(7);
    expect(result.wonLeads).toBe(2);
    expect(result.lostLeads).toBe(4);
    expect(result.pipelineValueCents).toBe(30000);
  });

  it("mantiene organizationId en todas las consultas del dashboard", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/server/dashboard/metrics.ts"),
      "utf8"
    );
    const scopes = source.match(/organization_id = \$\{organizationId\}/g) ?? [];

    expect(scopes.length).toBeGreaterThanOrEqual(7);
    expect(source).toContain("where id = ${organizationId}");
    expect(source).not.toContain("where organization_id is not null");
  });
});
