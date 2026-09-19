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
});
