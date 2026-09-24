import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "@/server/ai/prompts";
import type { schema } from "@/lib/db";

function profile(): typeof schema.agentProfile.$inferSelect {
  return {
    id: "profile_test",
    organizationId: "org_test",
    enabled: true,
    name: "Grissel",
    tone: "cercano",
    instructions: null,
    escalationRules: null,
    greeting: "Hola, ¿en qué puedo ayudarte?",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("continuidad conversacional del agente", () => {
  it("marca un saludo repetido como continuación y prohíbe reiniciar el discurso", () => {
    const prompt = buildAgentSystemPrompt({
      profile: profile(),
      kb: [],
      stages: [{ name: "Nuevo" }],
      repeatedGreeting: true,
    });

    expect(prompt).toContain("CONTINUIDAD DE ESTE TURNO");
    expect(prompt).toContain("NO reinicies la presentación");
    expect(prompt).toContain("NO repitas el catálogo/servicios");
    expect(prompt).toContain("Usa el historial completo de la conversación");
  });

  it("mantiene la regla general antirrepetición aun sin saludo repetido", () => {
    const prompt = buildAgentSystemPrompt({
      profile: profile(),
      kb: [],
      stages: [{ name: "Nuevo" }],
      repeatedGreeting: false,
    });

    expect(prompt).not.toContain("CONTINUIDAD DE ESTE TURNO");
    expect(prompt).toContain(
      "No repitas textualmente ni reformules sustancialmente una respuesta que ya enviaste"
    );
  });
});
