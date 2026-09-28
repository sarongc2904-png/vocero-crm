import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("agendamiento rápido con catálogo operativo", () => {
  it("expone sólo un catálogo mínimo con permiso de crear citas", () => {
    const route = source("src/app/api/calendar/catalog/route.ts");

    expect(route).toContain('withOrgPermissions(["appointments.create"]');
    expect(route).toContain("listServices");
    expect(route).toContain("listProfessionals");
    expect(route).toContain('service.active');
    expect(route).toContain('professional.status === "active"');
    expect(route).not.toContain("professional.email");
    expect(route).not.toContain("professional.phone");
    expect(route).toContain("canConfigureCatalog");
    expect(route).toContain('"settings.read"');
  });

  it("usa servicio y profesional para consultar y crear la cita", () => {
    const dialog = source("src/components/inbox/quick-booking-dialog.tsx");

    expect(dialog).toContain("/api/calendar/catalog");
    expect(dialog).toContain('params.set("serviceId", serviceId)');
    expect(dialog).toContain('params.set("professionalId", professionalId)');
    expect(dialog).toContain("serviceId,");
    expect(dialog).toContain("professionalId,");
    expect(dialog).toContain("Selecciona un servicio");
    expect(dialog).toContain("Selecciona profesional");
  });

  it("explica cuándo usa la agenda general y enlaza la configuración si procede", () => {
    const dialog = source("src/components/inbox/quick-booking-dialog.tsx");

    expect(dialog).toContain("Usando agenda general");
    expect(dialog).toContain("Todavía no hay un servicio y un profesional activos vinculados.");
    expect(dialog).toContain("catalog.canConfigureCatalog");
    expect(dialog).toContain('href="/settings/beauty"');
    expect(dialog).toContain("Configurar servicios y personal");
  });
});
