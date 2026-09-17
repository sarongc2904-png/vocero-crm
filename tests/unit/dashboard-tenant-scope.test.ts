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

  it("no mezcla monto desconocido ni moneda ajena con el total del tenant", () => {
    expect(metricsSource).toContain("pipeline_amount_known");
    expect(metricsSource).toContain("pipeline_amount_unknown");
    expect(metricsSource).toContain("pipeline_amount_other_currency");
    expect(metricsSource).toContain("coalesce(l.currency, ${businessCurrency}) = ${businessCurrency}");
    expect(pageSource).toContain("sin monto");
    expect(pageSource).toContain("en otra moneda");
  });

  it("calcula hoy con la zona horaria configurada", () => {
    expect(metricsSource).toContain("at time zone ${timezone}");
    expect(pageSource).toContain("calendar.timezone");
  });

  it("el modo superadmin conserva el organizationId activo", () => {
    expect(pageSource).toContain("session.organizationId,");
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
