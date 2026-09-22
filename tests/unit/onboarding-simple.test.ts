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
    expect(onboarding).toContain('label: "Haz una prueba"');

    expect(onboarding).not.toContain('{ id: "services", label: "Servicios"');
    expect(onboarding).not.toContain('{ id: "professionals", label: "Profesionales"');
    expect(onboarding).not.toContain('{ id: "hours", label: "Horarios"');
  });

  it("deja horario y Calendar como opcionales", () => {
    const onboarding = source("src/server/commercial/onboarding.ts");

    expect(onboarding).toContain('id: "timezone"');
    expect(onboarding).toContain('label: "Horario y zona del negocio"');
    expect(onboarding).toContain('id: "calendar"');
    expect(onboarding).toContain("optional: true");
  });

  it("usa lenguaje de siguiente paso en la interfaz", () => {
    const page = source("src/app/(app)/onboarding/page.tsx");

    expect(page).toContain("Vamos paso a paso");
    expect(page).toContain('"Continuar"');
    expect(page).toContain("pueden configurarse después");
  });
});
