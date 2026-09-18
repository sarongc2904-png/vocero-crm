import { describe, expect, it } from "vitest";
import { resolveStage } from "@/server/ai/actions";
import { buildAgentSystemPrompt } from "@/server/ai/prompts";

const profile = {
  name: "Asistente",
  tone: null,
  instructions:
    "Antes de reservar pide nombre y teléfono y recuerda la cita dos horas antes.",
  escalationRules: null,
  greeting: null,
} as Parameters<typeof buildAgentSystemPrompt>[0]["profile"];

function prompt(stages: string[]) {
  return buildAgentSystemPrompt({
    profile,
    kb: [],
    stages: stages.map((name) => ({ name })),
    agenda: true,
  });
}

describe("Wave 2 - contrato real del agente", () => {
  it("usa el nombre exacto de la etapa de interés configurada", () => {
    const text = prompt(["Nuevo", "Interesado", "Cliente"]);

    expect(text).toContain('move_stage usando EXACTAMENTE la etapa "Interesado"');
    expect(text).not.toContain("etapa de interesados");
  });

  it("no inventa una etapa de interés si el pipeline no la tiene", () => {
    const text = prompt(["Nuevo", "En conversación", "Cliente"]);

    expect(text).toContain("NO existe una etapa explícita de interés/calificación");
    expect(text).toContain("NO inventes una etapa");
  });

  it("declara que update_lead solo añade una nota y no cambia datos del contacto", () => {
    const text = prompt(["Nuevo", "Interesado"]);

    expect(text).toContain("añadir una nota interna a la ficha del contacto");
    expect(text).toContain("No cambia nombre, teléfono, etapa ni otros campos");
  });

  it("las instrucciones libres no pueden prometer capacidades que el backend no ejecuta", () => {
    const text = prompt(["Nuevo", "Interesado"]);

    expect(text).toContain("no prometas recordatorios automáticos");
    expect(text).toContain("Las instrucciones libres del perfil del negocio nunca pueden ampliar");
  });

  it("resolveStage no convierte una etapa inexistente en otra por aproximación", () => {
    const stages = [{ id: "stg_1", name: "Interesado" }];

    expect(resolveStage("Interesado", stages)?.id).toBe("stg_1");
    expect(resolveStage("interesado", stages)?.id).toBe("stg_1");
    expect(resolveStage("interesados", stages)).toBeNull();
  });
});
