import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPersonas,
  DEFAULT_SCENARIO_SCRIPTS,
  SCENARIO_KEYS,
} from "@/server/lab/personas";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("lab personas per organization", () => {
  it("uses industry-neutral defaults", () => {
    const personas = buildPersonas();
    const text = personas.flatMap((persona) => persona.script).join(" ").toLowerCase();

    expect(personas).toHaveLength(6);
    expect(text).not.toContain("taladro");
    expect(text).not.toContain("martillo");
    expect(text).not.toContain("lijadora");
    expect(text).not.toContain("pintura");
  });

  it("uses the scripts configured for the active tenant", () => {
    const personas = buildPersonas({
      enabledScenarios: ["comprador_decidido", "pide_humano"],
      scenarioScripts: {
        comprador_decidido: [
          "Hola, quiero contratar mi tarjeta digital.",
          "¿Cuánto cuesta y cómo empiezo?",
        ],
        pide_humano: ["Quiero hablar con un asesor de Conecta Digital."],
      },
    });

    expect(personas.map((persona) => persona.key)).toEqual([
      "comprador_decidido",
      "pide_humano",
    ]);
    expect(personas[0]?.script[0]).toContain("tarjeta digital");
    expect(personas[1]?.script[0]).toContain("Conecta Digital");
  });

  it("falls back per scenario without leaking another industry", () => {
    const personas = buildPersonas({
      enabledScenarios: [...SCENARIO_KEYS],
      scenarioScripts: { comprador_decidido: [] },
    });

    expect(personas[0]?.script).toEqual(
      DEFAULT_SCENARIO_SCRIPTS.comprador_decidido
    );
  });
  it("usa el número de escenarios habilitados en el progreso de la UI", () => {
    const client = source("src/components/lab/lab-client.tsx");

    expect(client).toContain("profile?.enabledScenarios.length ?? SCENARIOS.length");
    expect(client).not.toContain("setProgress({ done: 0, total: 6 })");
  });

});
