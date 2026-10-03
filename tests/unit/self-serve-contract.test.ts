import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("contrato self-serve", () => {
  it("fija explícitamente como activa la organización recién creada", () => {
    const route = source("src/app/api/organizations/self-serve/route.ts");
    expect(route).toContain("organizationId: organization.id");
    expect(route).toContain("setActiveOrganization");
  });

  it("no crea calendar_settings durante el bootstrap", () => {
    const organizations = source("src/server/auth/organizations.ts");
    expect(organizations).not.toContain("schema.calendarSettings");
  });

  it("exige zona horaria antes de activar el agente", () => {
    const route = source("src/app/api/agent/profile/route.ts");
    expect(route).toContain("isCalendarSettingsConfigured");
    expect(route).toContain("timezone_required");
  });

  it("el personal parte de la agenda visible y no del navegador", () => {
    const client = source("src/components/settings/beauty-settings-client.tsx");
    expect(client).toContain('fetch("/api/calendar/settings")');
    expect(client).toContain("MEXICO_TIMEZONES.map");
    expect(client).not.toContain("resolvedOptions().timeZone");
  });

  it("la agenda inicial no preselecciona silenciosamente una zona", () => {
    const client = source("src/components/settings/agenda-client.tsx");
    expect(client).toContain('timezone: data.configured ? data.settings.timezone : ""');
    expect(client).toContain("Selecciona una zona horaria");
  });
});
