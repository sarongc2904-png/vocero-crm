import { beforeEach, describe, expect, it, vi } from "vitest";

const chatJson = vi.fn();

vi.mock("@/lib/ai", () => ({
  chatJson: (...args: unknown[]) => chatJson(...args),
}));

import { computeScore, judgeCase, Verdict } from "@/server/lab/judge";
import { buildJudgePrompt } from "@/server/ai/prompts";

describe("judge prompt contract", () => {
  it("declara evidenceRefs obligatorio y evidencia como string", () => {
    const prompt = buildJudgePrompt({
      persona: "prueba",
      transcript: [],
      kbText: "",
      behaviorText: "",
      agendaEnabled: false,
    }).system;

    expect(prompt).toContain('"evidenceRefs"');
    expect(prompt).toContain("`evidenceRefs` es OBLIGATORIO");
    expect(prompt).toContain("`evidencia` SIEMPRE debe ser string");
    expect(prompt).toContain("agenda DESHABILITADA");
    expect(prompt).toContain("falla grave tipo=alucinacion");
    expect(prompt).toContain("`handoff_innecesario`");
    expect(prompt).toContain(
      "Preguntas normales sobre opciones, servicios, precios, condiciones o intención de compra"
    );
  });

  it("acepta handoff_innecesario en el contrato estructurado", () => {
    const result = Verdict.safeParse({
      veredicto: "amarillo",
      hallazgos: [
        {
          tipo: "handoff_innecesario",
          severity: "menor",
          evidencia: "handoff observado",
          evidenceRefs: [{ source: "action_trace", index: 0 }],
          reason: "El agente escaló sin necesidad.",
        },
      ],
    });

    expect(result.success).toBe(true);
  });
});

describe("judgeCase (FR-032)", () => {
  beforeEach(() => chatJson.mockReset());

  it("veredicto válido → done", async () => {
    chatJson.mockResolvedValue({
      ok: true,
      data: { veredicto: "verde", hallazgos: [] },
      raw: "{}",
    });
    const outcome = await judgeCase({
      personaKey: "comprador_decidido",
      transcript: [{ role: "cliente", text: "hola" }],
      kbText: "kb",
      behaviorText: "b",
      actionTrace: [],
    });
    expect(outcome.status).toBe("done");
    // usa el modelo del juez (opts.judge)
    expect(chatJson.mock.calls[0]![2]).toMatchObject({ judge: true });
  });

  it.each(["comprador_decidido", "pregunton_precios"])(
    "conserva handoff_innecesario aunque exista handoff real: %s",
    async (personaKey) => {
      chatJson.mockResolvedValue({
        ok: true,
        data: {
          veredicto: "rojo",
          hallazgos: [
            {
              tipo: "handoff_innecesario",
              severity: "grave",
              evidencia: "handoff prematuro",
              evidenceRefs: [{ source: "action_trace", index: 0 }],
              reason: "El agente transfirió una consulta comercial que podía continuar.",
            },
          ],
        },
        raw: "{}",
      });

      const outcome = await judgeCase({
        personaKey,
        transcript: [
          { role: "cliente", text: "Hola, ¿qué opciones manejan?" },
          { role: "agente", text: "Voy a pasarte con un asesor." },
        ],
        kbText: "Servicio A: $500 MXN. Servicio B: $900 MXN.",
        behaviorText: "Responde consultas comerciales con la información disponible.",
        actionTrace: [
          {
            turn: 1,
            customerMessage: "Hola, ¿qué opciones manejan?",
            agentMessages: ["Voy a pasarte con un asesor."],
            observedActions: ["reply", "handoff"],
            result: {
              handoffReason: "modelo",
              contactNotesChanged: false,
              stageChanged: null,
              bookingCreated: false,
            },
          },
        ],
      });

      expect(outcome.status).toBe("done");

      if (outcome.status === "done") {
        expect(outcome.verdict.veredicto).toBe("rojo");
        expect(outcome.verdict.hallazgos).toHaveLength(1);
        expect(outcome.verdict.hallazgos[0]?.tipo).toBe("handoff_innecesario");
      }
    }
  );

  it("elimina debio_escalar cuando el trace confirma que sí hubo handoff", async () => {
    chatJson.mockResolvedValue({
      ok: true,
      data: {
        veredicto: "rojo",
        hallazgos: [
          {
            tipo: "debio_escalar",
            severity: "grave",
            evidencia: "debería escalar",
            evidenceRefs: [{ source: "action_trace", index: 0 }],
            reason: "El juez creyó erróneamente que no hubo handoff.",
          },
        ],
      },
      raw: "{}",
    });

    const outcome = await judgeCase({
      personaKey: "pide_humano",
      transcript: [
        { role: "cliente", text: "Quiero hablar con una persona." },
        { role: "agente", text: "Claro. Voy a pasarte con un asesor." },
      ],
      kbText: "",
      behaviorText: "",
      actionTrace: [
        {
          turn: 1,
          customerMessage: "Quiero hablar con una persona.",
          agentMessages: ["Claro. Voy a pasarte con un asesor."],
          observedActions: ["handoff"],
          result: {
            handoffReason: "cliente",
            contactNotesChanged: false,
            stageChanged: null,
            bookingCreated: false,
          },
        },
      ],
    });

    expect(outcome.status).toBe("done");

    if (outcome.status === "done") {
      expect(outcome.verdict).toEqual({
        veredicto: "verde",
        hallazgos: [],
      });
    }
  });

  it("mantiene verde un handoff correcto cuando el cliente pidió humano", async () => {
    chatJson.mockResolvedValue({
      ok: true,
      data: {
        veredicto: "verde",
        hallazgos: [],
      },
      raw: "{}",
    });

    const outcome = await judgeCase({
      personaKey: "pide_humano",
      transcript: [
        { role: "cliente", text: "Prefiero hablar con una persona." },
        { role: "agente", text: "Claro. Voy a pasarte con un asesor." },
      ],
      kbText: "",
      behaviorText: "",
      actionTrace: [
        {
          turn: 1,
          customerMessage: "Prefiero hablar con una persona.",
          agentMessages: ["Claro. Voy a pasarte con un asesor."],
          observedActions: ["handoff"],
          result: {
            handoffReason: "cliente",
            contactNotesChanged: false,
            stageChanged: null,
            bookingCreated: false,
          },
        },
      ],
    });

    expect(outcome.status).toBe("done");

    if (outcome.status === "done") {
      expect(outcome.verdict.veredicto).toBe("verde");
      expect(outcome.verdict.hallazgos).toEqual([]);
    }
  });

  it("una abstención de conocimiento real sigue siendo segura", async () => {
    chatJson.mockResolvedValue({
      ok: true,
      data: {
        veredicto: "rojo",
        hallazgos: [
          {
            tipo: "fuera_de_kb",
            severity: "grave",
            evidencia: "sin dato",
            evidenceRefs: [{ source: "agent_message", index: 0 }],
            reason: "El juez intentó penalizar una abstención segura.",
          },
        ],
      },
      raw: "{}",
    });

    const outcome = await judgeCase({
      personaKey: "fuera_de_kb",
      transcript: [
        { role: "cliente", text: "¿Cuál es el precio de ese servicio?" },
        {
          role: "agente",
          text: "No tengo ese precio confirmado. Necesito verificarlo con el equipo.",
        },
      ],
      kbText: "",
      behaviorText: "",
      actionTrace: [],
    });

    expect(outcome.status).toBe("done");

    if (outcome.status === "done") {
      expect(outcome.verdict).toEqual({
        veredicto: "verde",
        hallazgos: [],
      });
    }
  });

  it("un simple handoff no se considera abstención segura de conocimiento", async () => {
    chatJson.mockResolvedValue({
      ok: true,
      data: {
        veredicto: "rojo",
        hallazgos: [
          {
            tipo: "fuera_de_kb",
            severity: "grave",
            evidencia: "handoff",
            evidenceRefs: [{ source: "agent_message", index: 0 }],
            reason: "La transferencia no es una abstención de conocimiento.",
          },
        ],
      },
      raw: "{}",
    });

    const outcome = await judgeCase({
      personaKey: "pregunton_precios",
      transcript: [
        { role: "cliente", text: "¿Qué opciones manejan?" },
        { role: "agente", text: "Voy a pasarte con un asesor." },
      ],
      kbText: "Hay opciones documentadas.",
      behaviorText: "",
      actionTrace: [],
    });

    expect(outcome.status).toBe("done");

    if (outcome.status === "done") {
      expect(outcome.verdict.veredicto).toBe("rojo");
      expect(outcome.verdict.hallazgos).toHaveLength(1);
    }
  });

  it("salida inválida tras reintentos internos → judge_failed (no lanza)", async () => {
    chatJson.mockResolvedValue({
      ok: false,
      error: "invalid_output",
      detail: "no cumple el esquema (raw=...)",
    });
    const outcome = await judgeCase({
      personaKey: "fuera_de_kb",
      transcript: [],
      kbText: "",
      behaviorText: "",
      actionTrace: [],
    });
    expect(outcome.status).toBe("judge_failed");
  });
});

describe("computeScore (FR-033: judge_failed excluido del denominador)", () => {
  it("pondera verde=1, amarillo=0.5, rojo=0", () => {
    const score = computeScore([
      { status: "done", veredicto: "verde" },
      { status: "done", veredicto: "amarillo" },
      { status: "done", veredicto: "rojo" },
    ]);
    expect(score).toBe(50); // (1 + 0.5 + 0) / 3 = 0.5
  });

  it("judge_failed NO cuenta en el denominador", () => {
    const score = computeScore([
      { status: "done", veredicto: "verde" },
      { status: "done", veredicto: "verde" },
      { status: "judge_failed", veredicto: null },
    ]);
    expect(score).toBe(100); // 2/2, no 2/3
  });

  it("todo judge_failed → sin score (null)", () => {
    expect(
      computeScore([{ status: "judge_failed", veredicto: null }])
    ).toBeNull();
  });

  it("6 verdes → 100; 6 rojos → 0", () => {
    const verdes = Array(6).fill({ status: "done", veredicto: "verde" });
    const rojos = Array(6).fill({ status: "done", veredicto: "rojo" });
    expect(computeScore(verdes)).toBe(100);
    expect(computeScore(rojos)).toBe(0);
  });
});
