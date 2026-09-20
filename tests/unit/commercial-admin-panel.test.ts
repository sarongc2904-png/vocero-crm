import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("panel comercial de superadmin", () => {
  it("protege la ruta y la API para superadmin", () => {
    const page = source("src/app/(app)/admin/clients/page.tsx");
    const route = source("src/app/api/admin/commercial/route.ts");

    expect(page).toContain("if (!session.isSuperadmin) redirect");
    expect(route).toContain("Esta operación requiere superadmin");
    expect(route).toContain("allowBlockedCommercialAccess: true");
  });

  it("permite administrar cuentas y planes", () => {
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
    expect(admin).toContain("updateCommercialPlan");
    expect(admin).toContain("monthlyPriceCents");
    expect(admin).toContain("trialDays");
  });

  it("la UI muestra gestión de clientes y configuración de planes", () => {
    const client = source("src/components/admin/commercial-admin-client.tsx");

    expect(client).toContain("Clientes y planes");
    expect(client).toContain("Configuración de planes");
    expect(client).toContain("Extender demo");
    expect(client).toContain("Activar");
    expect(client).toContain("Suspender");
    expect(client).toContain("Reactivar");
    expect(client).toContain("Cancelar");
    expect(client).toContain("Guardar plan");
  });

  it("las altas nuevas toman trial_days del plan, no un valor fijo", () => {
    const organizations = source("src/server/auth/organizations.ts");

    expect(organizations).toContain("schema.commercialPlan.trialDays");
    expect(organizations).toContain("plan.trialDays * 86_400_000");
    expect(organizations).not.toContain("+ 3 * 86_400_000");
  });

  it("el menú solo expone Clientes cuando el usuario es superadmin", () => {
    const layout = source("src/app/(app)/layout.tsx");
    const shell = source("src/components/app-shell.tsx");
    const nav = source("src/components/app-nav.tsx");

    expect(layout).toContain("isSuperadmin={session.isSuperadmin}");
    expect(shell).toContain("isSuperadmin={isSuperadmin}");
    expect(nav).toContain("{isSuperadmin && (");
    expect(nav).toContain('href="/admin/clients"');
  });
});
