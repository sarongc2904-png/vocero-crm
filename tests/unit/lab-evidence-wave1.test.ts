import { describe, expect, it } from "vitest";
import {
  Verdict,
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

  it("descarta debio_escalar cuando el action_trace demuestra que sí hubo handoff", () => {
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
      expect(result.verdict.veredicto).toBe("verde");
      expect(result.verdict.hallazgos).toEqual([]);
    }
  });

  it("descarta debio_escalar aunque el juez cite solo el farewell del agente", () => {
    const transcriptWithFarewell = [
      { role: "cliente" as const, text: "Quiero contratar." },
      {
        role: "agente" as const,
        text: "Voy a pasar tu solicitud a un asesor para continuar.",
      },
    ];
    const handoffTrace: AgentActionTrace = [
      {
        turn: 1,
        customerMessage: "Quiero contratar.",
        agentMessages: ["Voy a pasar tu solicitud a un asesor para continuar."],
        observedActions: ["reply", "handoff"],
        result: {
          handoffReason: "modelo",
          contactNotesChanged: false,
          stageChanged: null,
          bookingCreated: false,
        },
      },
    ];

    const result = validateAndAnchorVerdict({
      verdict: verdict({
        tipo: "debio_escalar",
        evidenceRefs: [{ source: "agent_message", index: 0 }],
      }),
      transcript: transcriptWithFarewell,
      actionTrace: handoffTrace,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.veredicto).toBe("verde");
      expect(result.verdict.hallazgos).toEqual([]);
    }
  });

  it("descarta fuera_de_kb cuando la evidencia es una abstención segura", () => {
    const abstentionTranscript = [
      { role: "cliente" as const, text: "¿Cuánto cuesta?" },
      {
        role: "agente" as const,
        text: "No tengo información sobre precios en este momento. Puedo confirmarlo con el equipo.",
      },
    ];

    const result = validateAndAnchorVerdict({
      verdict: verdict({
        tipo: "fuera_de_kb",
        evidenceRefs: [{ source: "agent_message", index: 0 }],
      }),
      transcript: abstentionTranscript,
      actionTrace: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.veredicto).toBe("verde");
      expect(result.verdict.hallazgos).toEqual([]);
    }
  });

  it("conserva fuera_de_kb si la respuesta contiene un dato concreto no confirmado", () => {
    const unsafeTranscript = [
      { role: "cliente" as const, text: "¿Cuánto cuesta?" },
      {
        role: "agente" as const,
        text: "No tengo el precio confirmado, pero cuesta $999 MXN.",
      },
    ];

    const result = validateAndAnchorVerdict({
      verdict: verdict({
        tipo: "fuera_de_kb",
        evidenceRefs: [{ source: "agent_message", index: 0 }],
      }),
      transcript: unsafeTranscript,
      actionTrace: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.hallazgos).toHaveLength(1);
      expect(result.verdict.hallazgos[0]!.tipo).toBe("fuera_de_kb");
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

  it("el schema no permite citar mensajes del cliente", () => {
    const parsed = Verdict.safeParse({
      ...verdict(),
      hallazgos: [
        {
          ...verdict().hallazgos[0],
          tipo: "alucinacion",
          evidenceRefs: [{ source: "customer_message", index: 0 }],
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });
});
