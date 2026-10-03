import { describe, expect, it } from "vitest";
import {
  buildAgentSystemPrompt,
  groundedConversationReply,
} from "@/server/ai/prompts";
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

  it("la intención fuerte pide solo el primer dato de cita que falta", () => {
    const knowledgeText = [
      "Para agendar una cita solicitar:",
      "- Nombre completo",
      "- Número de teléfono",
      "- Servicio o motivo de consulta",
      "- Limpieza dental: $700 MXN",
    ].join("\n");

    expect(
      groundedConversationReply({
        inboundText: "Quiero avanzar hoy",
        customerHistoryText: "Quiero avanzar hoy",
        knowledgeText,
      })
    ).toBe("Para avanzar, ¿me comparte su nombre completo?");
    expect(
      groundedConversationReply({
        inboundText: "Quiero avanzar hoy",
        customerHistoryText: "Soy Juan Pérez. Quiero avanzar hoy",
        knowledgeText,
      })
    ).toBe("Gracias. ¿Me comparte su número de teléfono?");
    expect(
      groundedConversationReply({
        inboundText: "Quiero avanzar hoy",
        customerHistoryText: "Soy Juan Pérez. Mi teléfono es 867 123 4567. Quiero avanzar hoy",
        knowledgeText,
      })
    ).toBe("Gracias. ¿Qué servicio o motivo de consulta le interesa?");
    expect(
      groundedConversationReply({
        inboundText: "Quiero avanzar hoy",
        customerHistoryText:
          "Soy Juan Pérez. Mi teléfono es 867 123 4567. Quiero limpieza y avanzar hoy",
        knowledgeText,
      })
    ).toBeNull();
  });
});
