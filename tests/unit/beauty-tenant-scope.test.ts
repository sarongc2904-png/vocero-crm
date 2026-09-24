import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe("catálogo beauty multi-tenant", () => {
  it("scopea lecturas, cambios y relaciones por organizationId", () => {
    const catalog = source("src/server/beauty/catalog.ts");
    const availability = source("src/server/beauty/availability.ts");

    expect(catalog.match(/scoped\(/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
    expect(catalog).toContain("Uno o más servicios no pertenecen a esta organización");
    expect(availability.match(/scoped\(/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
    expect(availability).toContain("assertOwnProfessional");
  });

  it("el API deriva el tenant de sesión y nunca del body", () => {
    for (const path of [
      "src/app/api/services/route.ts",
      "src/app/api/services/[id]/route.ts",
      "src/app/api/professionals/route.ts",
      "src/app/api/professionals/[id]/route.ts",
      "src/app/api/professionals/[id]/availability/route.ts",
    ]) {
      const route = source(path);
      expect(route).toContain("session.organizationId");
      expect(route).not.toMatch(/organizationId:\s*z\./);
    }
  });
  it("permite editar y eliminar servicios/profesionales sin salir del tenant", () => {
    const catalog = source("src/server/beauty/catalog.ts");
    const serviceRoute = source("src/app/api/services/[id]/route.ts");
    const professionalRoute = source("src/app/api/professionals/[id]/route.ts");
    const ui = source("src/components/settings/beauty-settings-client.tsx");

    expect(catalog).toContain("export async function deleteService");
    expect(catalog).toContain("export async function deleteProfessional");
    expect(catalog.match(/\.delete\(schema\.(service|professional)\)/g)?.length ?? 0).toBe(2);
    expect(serviceRoute).toContain("export const DELETE");
    expect(professionalRoute).toContain("export const DELETE");
    expect(serviceRoute).toContain("session.organizationId");
    expect(professionalRoute).toContain("session.organizationId");
    expect(ui).toContain("Servicio eliminado");
    expect(ui).toContain("Profesional eliminado");
    expect(ui).toContain("Guardar cambios");
  });

});
