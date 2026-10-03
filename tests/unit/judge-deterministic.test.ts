import { beforeEach, describe, expect, it, vi } from "vitest";

const chatJson = vi.fn();

vi.mock("@/lib/ai", () => ({
  chatJson: (...args: unknown[]) => chatJson(...args),
}));

import {
  ADJUDICATION_VERSION,
  JUDGE_TEMPERATURE,
  adjudicate,
  judgeCase,
  orderHallazgos,
  replayJudgeVerdict,
  validateAndAnchorVerdict,
  verifyJudgeRecord,
  type JudgeRecord,
  type VerdictType,
} from "@/server/lab/judge";
import type { AgentActionTrace } from "@/server/lab/action-trace";

const transcript = [
  { role: "cliente" as const, text: "¿Cuánto cuesta la limpieza?" },
  { role: "agente" as const, text: "La limpieza cuesta $700 MXN." },
];

const evidenceText = "Limpieza dental: $700 MXN. Brackets desde $8,000 MXN.";

function hallucination(overrides: Partial<VerdictType["hallazgos"][number]> = {}) {
  return {
    veredicto: "rojo" as const,
    hallazgos: [
      {
        tipo: "alucinacion" as const,
        severity: "grave" as const,
        evidencia: "precio inventado",
        evidenceRefs: [{ source: "agent_message" as const, index: 0 }],
        reason: "El juez creyó que el precio era inventado.",
        ...overrides,
      },
    ],
  };
}

describe("juez determinista — muestreo fijo", () => {
  beforeEach(() => chatJson.mockReset());

  it("identifica la revisión determinista Judge Quality v6", () => {
    expect(ADJUDICATION_VERSION).toBe(6);
  });

  it("pide temperatura 0 al proveedor para que el veredicto no dependa del muestreo", async () => {
    chatJson.mockResolvedValue({
      ok: true,
      data: { veredicto: "verde", hallazgos: [] },
      raw: "{}",
    });

    await judgeCase({
      personaKey: "fuera_de_kb",
      transcript,
      kbText: evidenceText,
      behaviorText: "",
      actionTrace: [],
    });

    expect(chatJson.mock.calls[0]![2]).toMatchObject({
      judge: true,
      temperature: JUDGE_TEMPERATURE,
    });
    expect(JUDGE_TEMPERATURE).toBe(0);
  });
});

describe("grounding determinista contra la evidencia congelada", () => {
  it("desmiente una alucinación cuando la cifra está en la evidencia del juez", () => {
    const result = validateAndAnchorVerdict({
      verdict: hallucination(),
      transcript,
      actionTrace: [],
      evidenceText,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict).toEqual({ veredicto: "verde", hallazgos: [] });
    }
  });

  it("la evidencia también desmiente un fuera_de_kb con datos respaldados", () => {
    const result = validateAndAnchorVerdict({
      verdict: hallucination({ tipo: "fuera_de_kb" }),
      transcript,
      actionTrace: [],
      evidenceText,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.veredicto).toBe("verde");
    }
  });

  it("conserva la alucinación si UNA cifra citada no está en la evidencia", () => {
    const result = validateAndAnchorVerdict({
      verdict: hallucination(),
      transcript: [
        { role: "cliente", text: "¿Cuánto cuesta?" },
        { role: "agente", text: "La limpieza cuesta $999 MXN." },
      ],
      actionTrace: [],
      evidenceText,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.veredicto).toBe("rojo");
      expect(result.verdict.hallazgos).toHaveLength(1);
    }
  });

  it("no inventa grounding cuando el mensaje no cita cifras concretas", () => {
    const result = validateAndAnchorVerdict({
      verdict: hallucination(),
      transcript: [
        { role: "cliente", text: "¿Tienen sucursal en Cancún?" },
        { role: "agente", text: "Sí, tenemos sucursal en Cancún." },
      ],
      actionTrace: [],
      evidenceText,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.veredicto).toBe("rojo");
    }
  });

  it("sin evidencia congelada no aplica ninguna regla nueva (compatibilidad v1)", () => {
    const result = validateAndAnchorVerdict({
      verdict: hallucination(),
      transcript,
      actionTrace: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.veredicto).toBe("rojo");
    }
  });
});

describe("adjudicación offline contra acciones observadas", () => {
  it.each([
    ["offer_slots", "Te ofrezco el horario del lunes a las 10:00."],
    ["book_slot", "Tu cita quedó agendada."],
    ["reschedule_slot", "Tu cita quedó reprogramada."],
    ["cancel_booking", "Tu cita quedó cancelada."],
  ] as const)("descarta alucinación cuando %s ocurrió realmente", (action, message) => {
    const result = adjudicate({
      llmVerdict: hallucination(),
      transcript: [
        { role: "cliente", text: "Confirma la operación." },
        { role: "agente", text: message },
      ],
      actionTrace: [
        {
          turn: 1,
          customerMessage: "Confirma la operación.",
          agentMessages: [message],
          observedActions: ["reply", action],
          result: {
            handoffReason: null,
            contactNotesChanged: false,
            stageChanged: null,
            bookingCreated: action === "book_slot",
            bookingRescheduled: action === "reschedule_slot",
            bookingCancelled: action === "cancel_booking",
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict).toEqual({ veredicto: "verde", hallazgos: [] });
      expect(result.rejectedFindings).toHaveLength(1);
    }
  });

  it("mantiene el claim sin action event que lo respalde", () => {
    const message = "Tu cita quedó cancelada.";
    const result = adjudicate({
      llmVerdict: hallucination(),
      transcript: [
        { role: "cliente", text: "Cancela mi cita." },
        { role: "agente", text: message },
      ],
      actionTrace: [
        {
          turn: 1,
          customerMessage: "Cancela mi cita.",
          agentMessages: [message],
          observedActions: ["reply"],
          result: {
            handoffReason: null,
            contactNotesChanged: false,
            stageChanged: null,
            bookingCreated: false,
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verdict.veredicto).toBe("rojo");
  });
});

describe("orden canónico de hallazgos", () => {
  it("ordena por gravedad, luego por tipo", () => {
    const ordered = orderHallazgos([
      {
        tipo: "tono",
        severity: "menor",
        evidencia: "e",
        evidenceRefs: [{ source: "agent_message", index: 0 }],
        reason: "c",
      },
      {
        tipo: "alucinacion",
        severity: "grave",
        evidencia: "e",
        evidenceRefs: [{ source: "agent_message", index: 0 }],
        reason: "a",
      },
      {
        tipo: "fuera_de_kb",
        severity: "grave",
        evidencia: "e",
        evidenceRefs: [{ source: "agent_message", index: 0 }],
        reason: "b",
      },
    ]);

    expect(ordered.map((finding) => finding.tipo)).toEqual([
      "alucinacion",
      "fuera_de_kb",
      "tono",
    ]);
  });

  it("es estable ante el mismo conjunto en distinto orden de entrada", () => {
    const a = orderHallazgos([
      {
        tipo: "tono",
        severity: "menor",
        evidencia: "e",
        evidenceRefs: [{ source: "action_trace", index: 1 }],
        reason: "z",
      },
      {
        tipo: "tono",
        severity: "menor",
        evidencia: "e",
        evidenceRefs: [{ source: "action_trace", index: 0 }],
        reason: "a",
      },
    ]);
    const b = orderHallazgos([...a].reverse());

    expect(a).toEqual(b);
  });
});

describe("registro del juez y replay offline", () => {
  beforeEach(() => chatJson.mockReset());

  async function runJudge(): Promise<JudgeRecord> {
    chatJson.mockResolvedValue({
      ok: true,
      data: hallucination(),
      raw: "{}",
    });
    const outcome = await judgeCase({
      personaKey: "pregunton_precios",
      transcript,
      kbText: evidenceText,
      behaviorText: "Escalado: solo si el cliente lo pide",
      actionTrace: [],
      evidenceDigest: "evidencia-digest-1",
    });
    return outcome.record;
  }

  it("persiste el veredicto crudo, el final y sus digests", async () => {
    const record = await runJudge();

    expect(record.version).toBe(ADJUDICATION_VERSION);
    expect(record.status).toBe("done");
    expect(record.evidenceDigest).toBe("evidencia-digest-1");
    expect(record.behaviorText).toBe("Escalado: solo si el cliente lo pide");
    expect(record.rawVerdict?.hallazgos).toHaveLength(1);
    // El precio está en la evidencia congelada: el veredicto final es verde.
    expect(record.finalVerdict?.veredicto).toBe("verde");
    expect(record.verdictDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.judgeInputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyJudgeRecord(record)).toEqual({ ok: true });
  });

  it("el replay reproduce el veredicto SIN volver a llamar al modelo", async () => {
    const record = await runJudge();
    chatJson.mockClear();

    const replayed = replayJudgeVerdict({
      record,
      transcript,
      actionTrace: [],
      evidenceText,
    });

    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.matches).toBe(true);
      expect(replayed.verdict).toEqual(record.finalVerdict);
      expect(replayed.verdictDigest).toBe(record.verdictDigest);
    }
    expect(chatJson).not.toHaveBeenCalled();
  });

  it("el replay detecta un veredicto editado después de persistirse", async () => {
    const record = await runJudge();
    // El veredicto real es verde (el grounding desmintió la acusación); se
    // falsifica un rojo conservando el digest original.
    const tampered: JudgeRecord = {
      ...record,
      finalVerdict: { veredicto: "amarillo", hallazgos: [] },
    };

    const replayed = replayJudgeVerdict({
      record: tampered,
      transcript,
      actionTrace: [],
      evidenceText,
    });

    expect(replayed.ok).toBe(false);
    if (!replayed.ok) {
      expect(replayed.detail).toContain("verdict_digest_mismatch");
    }
  });

  it("detecta un prompt alterado comparando el digest de entrada", async () => {
    const record = await runJudge();
    const tampered: JudgeRecord = {
      ...record,
      judgePrompt: { ...record.judgePrompt, user: `${record.judgePrompt.user}\ninyectado` },
    };

    expect(verifyJudgeRecord(tampered)).toMatchObject({ ok: false });
  });

  it("un caso sin veredicto no es replayable", async () => {
    chatJson.mockResolvedValue({
      ok: false,
      error: "invalid_output",
      detail: "no cumple el esquema",
    });
    const outcome = await judgeCase({
      personaKey: "fuera_de_kb",
      transcript,
      kbText: "",
      behaviorText: "",
      actionTrace: [],
    });

    expect(outcome.status).toBe("judge_failed");

    const replayed = replayJudgeVerdict({
      record: outcome.record,
      transcript,
      actionTrace: [],
    });
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) {
      expect(replayed.detail).toContain("record_not_replayable");
    }
  });

  it("el mismo caso juzgado dos veces produce el mismo digest de veredicto", async () => {
    const first = await runJudge();
    const second = await runJudge();

    // Los prompts son idénticos byte a byte, así que el digest de entrada
    // coincide aunque el proveedor devuelva lo mismo.
    expect(first.judgeInputDigest).toBe(second.judgeInputDigest);
    expect(first.verdictDigest).toBe(second.verdictDigest);
  });
});

describe("action trace v1 en el juez", () => {
  it("un trace v1 sin campos v2 sigue adjudicándose igual", () => {
    const legacyTrace: AgentActionTrace = [
      {
        turn: 1,
        customerMessage: "Quiero hablar con una persona.",
        agentMessages: ["Claro, te paso con un asesor."],
        observedActions: ["reply", "handoff"],
        result: {
          handoffReason: "cliente",
          contactNotesChanged: false,
          stageChanged: null,
          bookingCreated: false,
        },
      },
    ];

    const result = validateAndAnchorVerdict({
      verdict: {
        veredicto: "rojo",
        hallazgos: [
          {
            tipo: "debio_escalar",
            severity: "grave",
            evidencia: "libre",
            evidenceRefs: [{ source: "action_trace", index: 0 }],
            reason: "El juez creyó que no hubo handoff.",
          },
        ],
      },
      transcript: [
        { role: "cliente", text: "Quiero hablar con una persona." },
        { role: "agente", text: "Claro, te paso con un asesor." },
      ],
      actionTrace: legacyTrace,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict).toEqual({ veredicto: "verde", hallazgos: [] });
    }
  });
});
