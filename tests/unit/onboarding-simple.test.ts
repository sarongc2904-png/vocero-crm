import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("onboarding simple para negocio general", () => {
  it("no exige pasos verticales de belleza para activar", () => {
    const onboarding = source("src/server/commercial/onboarding.ts");

    expect(onboarding).toContain('label: "Datos del negocio"');
    expect(onboarding).toContain('label: "Conecta WhatsApp"');
    expect(onboarding).toContain('label: "Enséñale a la IA sobre tu negocio"');
    expect(onboarding).toContain('label: "Prueba una conversación"');

    expect(onboarding).not.toContain('{ id: "services", label: "Servicios"');
    expect(onboarding).not.toContain('{ id: "professionals", label: "Profesionales"');
    expect(onboarding).not.toContain('{ id: "hours", label: "Horarios"');
  });

  it("exige zona horaria y deja Calendar como opcional", () => {
    const onboarding = source("src/server/commercial/onboarding.ts");

    expect(onboarding).toContain('id: "timezone"');
    expect(onboarding).toContain('label: "Configura la agenda general"');
    expect(onboarding).not.toMatch(/id: "timezone"[\s\S]{0,120}optional: true/);
    expect(onboarding).toContain('id: "calendar"');
    expect(onboarding).toMatch(/id: "calendar"[\s\S]{0,120}optional: true/);
  });

  it("usa lenguaje de siguiente paso en la interfaz", () => {
    const page = source("src/app/(app)/onboarding/page.tsx");
    const onboarding = source("src/server/commercial/onboarding.ts");

    expect(page).toContain("Vamos paso a paso");
    expect(page).toContain("Continuar");
    expect(page).toContain("Google Calendar puede configurarse después");
    expect(onboarding).toContain("const nextStep");
    expect(onboarding).toContain("input.activate");
    expect(onboarding).toContain("shouldMarkActivation");
  });
});
