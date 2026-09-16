import { describe, expect, it } from "vitest";
import {
  validateAndAnchorVerdict,
  type VerdictType,
} from "@/server/lab/judge";
import type { AgentActionTrace } from "@/server/lab/action-trace";

const transcript = [
  { role: "cliente" as const, text: "Cuesta $999, ¿verdad?" },
  { role: "agente" as const, text: "No tengo ese precio confirmado." },
  { role: "cliente" as const, text: "Quiero hablar con una persona." },
];

const trace: AgentActionTrace = [
  {
    turn: 1,
    customerMessage: "Cuesta $999, ¿verdad?",
    agentMessages: ["No tengo ese precio confirmado."],
    observedActions: ["reply"],
    result: {
      handoffReason: null,
      contactNotesChanged: false,
      stageChanged: null,
      bookingCreated: false,
    },
  },
  {
    turn: 2,
    customerMessage: "Quiero hablar con una persona.",
    agentMessages: [],
    observedActions: ["handoff"],
    result: {
      handoffReason: "cliente",
      contactNotesChanged: false,
      stageChanged: null,
      bookingCreated: false,
    },
  },
];

function verdict(overrides: Partial<VerdictType["hallazgos"][number]> = {}): VerdictType {
  return {
    veredicto: "amarillo",
    hallazgos: [
      {
        tipo: "tono",
        severity: "menor",
        evidencia: "texto libre no confiable",
        evidenceRefs: [{ source: "agent_message", index: 0 }],
        reason: "prueba",
        ...overrides,
      },
    ],
  };
}

describe("Wave 1 - evidencia anclada del juez", () => {
  it("reconstruye evidencia desde un mensaje real del agente", () => {
    const result = validateAndAnchorVerdict({
      verdict: verdict(),
      transcript,
      actionTrace: trace,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.hallazgos[0]!.evidencia).toBe(
        "No tengo ese precio confirmado."
      );
    }
  });

  it("acepta action_trace para efectos observados", () => {
    const result = validateAndAnchorVerdict({
      verdict: verdict({
        tipo: "debio_escalar",
        evidenceRefs: [{ source: "action_trace", index: 1 }],
      }),
      transcript,
      actionTrace: trace,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.hallazgos[0]!.evidencia).toContain("handoff");
      expect(result.verdict.hallazgos[0]!.evidencia).toContain("cliente");
    }
  });

  it("rechaza índices fuera de rango", () => {
    const result = validateAndAnchorVerdict({
      verdict: verdict({
        evidenceRefs: [{ source: "agent_message", index: 99 }],
      }),
      transcript,
      actionTrace: trace,
    });

    expect(result).toEqual({
      ok: false,
      detail: "invalid_evidence_ref: hallazgo=0 agent_message=99",
    });
  });

  it("una alucinación exige evidencia producida por el agente", () => {
    const result = validateAndAnchorVerdict({
      verdict: verdict({
        tipo: "alucinacion",
        evidencia: "Cuesta $999, ¿verdad?",
        evidenceRefs: [{ source: "action_trace", index: 0 }],
      }),
      transcript,
      actionTrace: trace,
    });

    expect(result).toEqual({
      ok: false,
      detail:
        "invalid_evidence_ref: hallazgo=0 alucinacion_requires_agent_message",
    });
  });

  it("no existe un tipo de referencia a mensajes del cliente", () => {
    const bad = {
      source: "customer_message",
      index: 0,
    } as unknown as VerdictType["hallazgos"][number]["evidenceRefs"][number];

    const result = validateAndAnchorVerdict({
      verdict: verdict({ evidenceRefs: [bad] }),
      transcript,
      actionTrace: trace,
    });

    expect(result.ok).toBe(false);
  });
});
