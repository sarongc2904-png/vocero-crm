import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("panel comercial de superadmin", () => {
  it("protege la API y la página con isSuperadmin", () => {
    const route = source("src/app/api/admin/commercial/route.ts");
    const page = source("src/app/(app)/admin/clients/page.tsx");

    expect(route).toContain("session.isSuperadmin");
    expect(route).toContain('apiError(403, "forbidden"');
    expect(page).toContain("if (!session.isSuperadmin)");
  });

  it("solo expone acciones comerciales explícitas", () => {
    const admin = source("src/server/commercial/admin.ts");

    for (const action of [
      "extend_trial",
      "activate",
      "suspend",
      "cancel",
      "reactivate",
      "change_plan",
    ]) {
      expect(admin).toContain(`"${action}"`);
    }
    expect(admin).not.toContain("delete(schema.organization)");
  });

  it("la extensión de demo está acotada y conserva datos", () => {
    const admin = source("src/server/commercial/admin.ts");

    expect(admin).toContain("Math.max(1, Math.min(365");
    expect(admin).toContain('status: "trial"');
    expect(admin).not.toContain(".delete(");
  });

  it("las nuevas organizaciones derivan el trial del plan, no de 3 días fijos", () => {
    const organizations = source("src/server/auth/organizations.ts");

    expect(organizations).toContain("plan.trialDays * 86_400_000");
    expect(organizations).not.toContain("3 * 86_400_000");
  });

  it("la navegación administrativa solo se muestra con isSuperadmin", () => {
    const shell = source("src/components/app-shell.tsx");
    const nav = source("src/components/app-nav.tsx");

    expect(shell).toContain("isSuperadmin={isSuperadmin}");
    expect(nav).toContain("{isSuperadmin && (");
    expect(nav).toContain('href="/admin/clients"');
  });
});
