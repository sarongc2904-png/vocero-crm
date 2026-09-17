import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const metricsSource = readFileSync(
  new URL("../../src/server/dashboard/metrics.ts", import.meta.url),
  "utf8"
);
const pageSource = readFileSync(
  new URL("../../src/app/(app)/dashboard/page.tsx", import.meta.url),
  "utf8"
);

describe("dashboard operativo por tenant", () => {
  it("toda familia de métricas recibe organizationId explícito", () => {
    expect(metricsSource).toContain("getDashboardMetrics(\n  organizationId: string");

    const expectedScopes = [
      "where id = ${organizationId}",
      "where c.organization_id = ${organizationId}",
      "where l.organization_id = ${organizationId}",
      "where b.organization_id = ${organizationId}",
      "where ps.organization_id = ${organizationId}",
      "where ca.organization_id = ${organizationId}",
    ];

    for (const scope of expectedScopes) {
      expect(metricsSource).toContain(scope);
    }
  });

  it("no mezcla monto desconocido con cero ni con valor conocido", () => {
    expect(metricsSource).toContain("pipeline_amount_known");
    expect(metricsSource).toContain("pipeline_amount_unknown");
    expect(pageSource).toContain("oportunidades sin monto");
  });

  it("el modo superadmin conserva el organizationId activo", () => {
    expect(pageSource).toContain("getDashboardMetrics(session.organizationId)");
    expect(pageSource).toContain("session.isSuperadmin");
    expect(pageSource).toContain("Estás administrando:");
  });

  it("expone carga por agente/equipo y conversaciones sin asignar", () => {
    expect(metricsSource).toContain("conversation_assignment");
    expect(metricsSource).toContain("unassigned");
    expect(metricsSource).toContain("'agent'::text as kind");
    expect(metricsSource).toContain("'team'::text as kind");
  });
});
