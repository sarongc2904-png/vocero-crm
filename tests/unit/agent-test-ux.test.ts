import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("prueba del agente", () => {
  it("usa lenguaje simple para la prueba principal", () => {
    const lab = source("src/components/lab/lab-client.tsx");

    expect(lab).toContain("Prueba del agente");
    expect(lab).toContain("Simulación interna — no envía mensajes reales");
    expect(lab).toContain("Probar agente");
    expect(lab).toContain("Resultado de la prueba");
    expect(lab).toContain("Conversación");
  });

  it("no expone términos técnicos en la experiencia principal", () => {
    const lab = source("src/components/lab/lab-client.tsx");

    expect(lab).not.toContain("OPENROUTER_API_TOKEN");
    expect(lab).not.toContain("Sandbox interno");
    expect(lab).not.toContain("Correr evaluación");
    expect(lab).not.toContain("Guardar en el KB");
    expect(lab).not.toContain("Score {score}");
  });
});
