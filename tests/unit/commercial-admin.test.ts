import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("panel comercial de superadmin", () => {
  it("protege la página y la API con isSuperadmin", () => {
    const page = source("src/app/(app)/admin/clients/page.tsx");
    const route = source("src/app/api/admin/commercial/route.ts");

    expect(page).toContain("if (!session.isSuperadmin)");
    expect(route).toContain("requireSuperadmin(session.isSuperadmin)");
    expect(route).toContain("allowBlockedCommercialAccess: true");
  });

  it("permite operar cuentas sin SQL manual", () => {
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
    expect(admin).not.toContain("delete(schema.organization)");
  });

  it("la extensión de demo está acotada y conserva datos", () => {
    const admin = source("src/server/commercial/admin.ts");

    expect(admin).toContain("Math.max(1, Math.min(365");
    expect(admin).toContain('status: "trial"');
    expect(admin).not.toContain(".delete(");
  });

  it("el alta de organizaciones usa trial_days del plan como fuente de verdad", () => {
    const organizations = source("src/server/auth/organizations.ts");

    expect(organizations).toContain("schema.commercialPlan.trialDays");
    expect(organizations).toContain("plan.trialDays * 86_400_000");
    expect(organizations).not.toContain("3 * 86_400_000");
  });

  it("el panel expone edición de precio y demo", () => {
    const client = source("src/components/admin/commercial-admin-client.tsx");

    expect(client).toContain("Precio mensual");
    expect(client).toContain("Días de demo");
    expect(client).toContain('target: "plan"');
    expect(client).toContain("monthlyPriceCents");
    expect(client).toContain("trialDays");
  });

  it("permite alta controlada de clientes desde superadmin", () => {
    const route = source("src/app/api/admin/commercial/route.ts");
    const admin = source("src/server/commercial/admin.ts");
    const client = source("src/components/admin/commercial-admin-client.tsx");

    expect(route).toContain("export const POST");
    expect(route).toContain("createCommercialClient");
    expect(admin).toContain("runInternalSignup");
    expect(admin).toContain("createOrganizationForOwner");
    expect(admin).toContain("organizationEntitlement");
    expect(client).toContain("+ Crear cliente");
    expect(client).toContain("Nombre del negocio");
    expect(client).toContain("Contraseña temporal");
    expect(client).toContain("Días de demo");
  });

  it("oculta tenants sin acceso del selector sin borrar sus datos", () => {
    const route = source("src/app/api/organizations/route.ts");
    const client = source("src/components/admin/commercial-admin-client.tsx");

    expect(route).toContain('organization.commercialStatus === "active"');
    expect(route).toContain('organization.commercialStatus !== "trial"');
    expect(route).not.toContain("session.isSuperadmin\n    ? organizations");
    expect(client).toContain("Desactivar acceso");
    expect(client).toContain("Sus datos se conservarán");
    expect(client).toContain("Reactivar");
  });

  it("si el tenant activo queda oculto, el selector cambia a uno visible", () => {
    const switcher = source("src/components/organization-switcher.tsx");

    expect(switcher).toContain("organizations.some((organization) =>");
    expect(switcher).toContain("organization.id === activeOrganizationId");
    expect(switcher).toContain("const fallbackOrganization = organizations[0]");
    expect(switcher).toContain("void switchOrganization(fallbackOrganization.id)");
  });

  it("evita que clientes creen tenants extra por su cuenta", () => {
    const nav = source("src/components/app-nav.tsx");
    const route = source("src/app/api/organizations/route.ts");
    const login = source("src/app/(auth)/login/page.tsx");

    expect(nav).toContain("canCreate={isSuperadmin}");
    expect(route).toContain("if (!session.isSuperadmin)");
    expect(route).toContain("Las nuevas organizaciones se crean desde administración");
    expect(login).toContain("Solicítalo al administrador de tu cuenta");
    expect(login).not.toContain("Crear la cuenta inicial");
  });

  it("la navegación administrativa solo se muestra con isSuperadmin", () => {
    const shell = source("src/components/app-shell.tsx");
    const nav = source("src/components/app-nav.tsx");

    expect(shell).toContain("isSuperadmin={isSuperadmin}");
    expect(nav).toContain("{isSuperadmin && (");
    expect(nav).toContain('href="/admin/clients"');
  });
});
