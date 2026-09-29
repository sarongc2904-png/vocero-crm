import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("activación guiada", () => {
  it("muestra progreso de pasos esenciales", () => {
    const page = source("src/app/(app)/onboarding/page.tsx");

    expect(page).toContain("onboarding.requiredCompleted");
    expect(page).toContain("onboarding.requiredTotal");
    expect(page).toContain("pasos esenciales completos");
    expect(page).not.toContain("onboarding.completed / onboarding.total");
  });

  it("usa nombres claros para agenda y prueba", () => {
    const onboarding = source("src/server/commercial/onboarding.ts");

    expect(onboarding).toContain('label: "Configura la agenda general"');
    expect(onboarding).toContain('label: "Prueba una conversación"');
  });
});
