import { describe, expect, it } from "vitest";
import {
  buildPersonas,
  DEFAULT_SCENARIO_SCRIPTS,
  SCENARIO_KEYS,
} from "@/server/lab/personas";

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
});
