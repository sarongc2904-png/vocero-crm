import { beforeEach, describe, expect, it, vi } from "vitest";

const chatJson = vi.fn();

vi.mock("@/lib/ai", () => ({
  chatJson: (...args: unknown[]) => chatJson(...args),
}));

import { adjudicate, computeScore, judgeCase, Verdict } from "@/server/lab/judge";
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
    expect(prompt).toContain("`eco_cliente`");
    expect(prompt).toContain("`repeticion`");
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

  it("acepta eco_cliente en el contrato estructurado", () => {
    const result = Verdict.safeParse({
      veredicto: "amarillo",
      hallazgos: [
        {
          tipo: "eco_cliente",
          severity: "menor",
          evidencia: "Quiero información sobre limpieza dental.",
          evidenceRefs: [{ source: "agent_message", index: 0 }],
          reason: "El agente repitió al cliente sin responder.",
        },
      ],
    });

    expect(result.success).toBe(true);
  });
});

describe("Judge Quality v6 — enforcement determinista", () => {
  function finding(input: {
    tipo: "eco_cliente" | "repeticion" | "respuesta_generica";
    refs: number[];
    reason: string;
    severity?: "menor" | "grave";
  }) {
    return {
      tipo: input.tipo,
      severity: input.severity ?? ("menor" as const),
      evidencia: "salida propuesta por el LLM",
      evidenceRefs: input.refs.map((index) => ({
        source: "agent_message" as const,
        index,
      })),
      reason: input.reason,
    };
  }

  it("rechaza un eco_cliente falso y lo reporta en rejectedFindings", () => {
    const proposed = finding({
      tipo: "eco_cliente",
      refs: [0],
      reason: "El agente hizo eco del cliente.",
    });
    const result = adjudicate({
      llmVerdict: { veredicto: "amarillo", hallazgos: [proposed] },
      transcript: [
        {
          role: "cliente",
          text: "¿Tienen algún descuento o condición especial?",
        },
        {
          role: "agente",
          text: "No manejamos descuentos o condiciones especiales de forma general. Si necesita más información sobre precios, puedo ayudarle a revisar las opciones disponibles.",
        },
      ],
      actionTrace: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict).toEqual({ veredicto: "verde", hallazgos: [] });
      expect(result.rejectedFindings).toEqual([
        expect.objectContaining({ finding: proposed }),
      ]);
    }
  });

  it("conserva un eco_cliente real sin duplicar el hallazgo determinista", () => {
    const proposed = finding({
      tipo: "eco_cliente",
      refs: [0],
      reason: "El agente repitió al cliente sin aportar avance.",
    });
    const result = adjudicate({
      llmVerdict: { veredicto: "amarillo", hallazgos: [proposed] },
      transcript: [
        { role: "cliente", text: "Gracias, lo voy a revisar." },
        { role: "agente", text: "Gracias, lo voy a revisar." },
      ],
      actionTrace: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.veredicto).toBe("amarillo");
      expect(
        result.verdict.hallazgos.filter((item) => item.tipo === "eco_cliente")
      ).toHaveLength(1);
      expect(result.rejectedFindings).toHaveLength(0);
    }
  });

  it("rechaza respuesta_generica de precio mal anclada y detecta el turno correcto", () => {
    const proposed = finding({
      tipo: "respuesta_generica",
      refs: [0],
      severity: "grave",
      reason:
        "El agente no respondió a la pregunta específica del cliente sobre precios y opciones, evadiendo con una respuesta genérica.",
    });
    const generic =
      "Claro, puedo ayudarte con eso. Dime qué información necesitas.";
    const result = adjudicate({
      llmVerdict: { veredicto: "rojo", hallazgos: [proposed] },
      transcript: [
        { role: "cliente", text: "Hola, ¿qué opciones manejan?" },
        { role: "agente", text: generic },
        { role: "cliente", text: "¿Cuánto cuesta cada opción?" },
        { role: "agente", text: generic },
      ],
      actionTrace: [],
      evidenceText: "Limpieza dental: $700 MXN. Brackets desde $8,000 MXN.",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.veredicto).toBe("amarillo");
      expect(result.rejectedFindings).toEqual([
        expect.objectContaining({ finding: proposed }),
      ]);
      expect(result.verdict.hallazgos).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tipo: "respuesta_generica",
            severity: "menor",
            evidenceRefs: [{ source: "agent_message", index: 1 }],
          }),
        ])
      );
      expect(
        result.verdict.hallazgos.some(
          (item) =>
            item.tipo === "respuesta_generica" &&
            item.evidenceRefs.some(
              (ref) => ref.source === "agent_message" && ref.index === 0
            )
        )
      ).toBe(false);
    }
  });

  it("rechaza una repetición LLM cuando los mensajes son distintos", () => {
    const proposed = finding({
      tipo: "repeticion",
      refs: [0, 1],
      reason: "El agente repitió exactamente su respuesta.",
    });
    const result = adjudicate({
      llmVerdict: { veredicto: "amarillo", hallazgos: [proposed] },
      transcript: [
        { role: "cliente", text: "Hola" },
        { role: "agente", text: "Buenos días, ¿en qué puedo ayudarle?" },
        { role: "cliente", text: "Quiero precios" },
        {
          role: "agente",
          text: "Nuestros precios dependen del servicio.",
        },
      ],
      actionTrace: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict).toEqual({ veredicto: "verde", hallazgos: [] });
      expect(result.rejectedFindings).toHaveLength(1);
    }
  });

  it("conserva exactamente una repetición LLM válida para el mismo par", () => {
    const repeated =
      "Claro, puedo ayudarte con eso. Dime qué información necesitas.";
    const proposed = finding({
      tipo: "repeticion",
      refs: [0, 1],
      reason: "El agente repitió exactamente su respuesta anterior.",
    });
    const result = adjudicate({
      llmVerdict: { veredicto: "amarillo", hallazgos: [proposed] },
      transcript: [
        { role: "cliente", text: "Hola, ¿qué opciones manejan?" },
        { role: "agente", text: repeated },
        { role: "cliente", text: "¿Qué incluye cada opción?" },
        { role: "agente", text: repeated },
      ],
      actionTrace: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.veredicto).toBe("amarillo");
      expect(
        result.verdict.hallazgos.filter((item) => item.tipo === "repeticion")
      ).toHaveLength(1);
      expect(result.rejectedFindings).toHaveLength(0);
    }
  });

  it("rechaza repetición cuando el cliente pidió explícitamente repetir", () => {
    const proposed = finding({
      tipo: "repeticion",
      refs: [0, 1],
      reason: "El agente repitió exactamente su respuesta anterior.",
    });
    const result = adjudicate({
      llmVerdict: { veredicto: "amarillo", hallazgos: [proposed] },
      transcript: [
        { role: "cliente", text: "¿Cuánto cuesta?" },
        { role: "agente", text: "Cuesta $700 MXN." },
        { role: "cliente", text: "¿Me lo puede decir otra vez?" },
        { role: "agente", text: "Cuesta $700 MXN." },
      ],
      actionTrace: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict).toEqual({ veredicto: "verde", hallazgos: [] });
      expect(result.rejectedFindings).toHaveLength(1);
    }
  });

  it("reproduce la corrida real y conserva sólo hallazgos temporalmente válidos", () => {
    const generic =
      "Claro, puedo ayudarte con eso. Dime qué información necesitas.";
    const discount =
      "No manejamos descuentos o condiciones especiales de forma general. Si necesita más información sobre precios, puedo ayudarle a revisar las opciones disponibles.";
    const invalidGeneric = finding({
      tipo: "respuesta_generica",
      refs: [0],
      severity: "grave",
      reason:
        "El agente no respondió a la pregunta específica del cliente sobre precios y opciones, evadiendo con una respuesta genérica.",
    });
    const invalidEcho = finding({
      tipo: "eco_cliente",
      refs: [3],
      reason: "El agente repitió información sin avanzar la conversación.",
    });
    const repetitions = [
      finding({
        tipo: "repeticion",
        refs: [0, 1],
        reason: "Repetición exacta entre los turnos 0 y 1.",
      }),
      finding({
        tipo: "repeticion",
        refs: [0, 2],
        reason: "Repetición exacta entre los turnos 0 y 2.",
      }),
      finding({
        tipo: "repeticion",
        refs: [3, 4],
        reason: "Repetición exacta entre los turnos 3 y 4.",
      }),
    ];
    const result = adjudicate({
      llmVerdict: {
        veredicto: "rojo",
        hallazgos: [invalidGeneric, invalidEcho, ...repetitions],
      },
      transcript: [
        { role: "cliente", text: "Hola, ¿qué opciones manejan?" },
        { role: "agente", text: generic },
        { role: "cliente", text: "¿Cuánto cuesta cada opción?" },
        { role: "agente", text: generic },
        { role: "cliente", text: "¿Qué incluye cada una?" },
        { role: "agente", text: generic },
        {
          role: "cliente",
          text: "¿Tienen algún descuento o condición especial?",
        },
        { role: "agente", text: discount },
        { role: "cliente", text: "Gracias, lo voy a revisar." },
        { role: "agente", text: discount },
      ],
      actionTrace: [],
      evidenceText: "Limpieza dental: $700 MXN. Brackets desde $8,000 MXN.",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.veredicto).toBe("amarillo");
      expect(result.rejectedFindings.map((item) => item.finding)).toEqual([
        invalidGeneric,
        invalidEcho,
      ]);
      expect(
        result.verdict.hallazgos.filter((item) => item.tipo === "repeticion")
      ).toHaveLength(3);
      expect(
        result.verdict.hallazgos.filter(
          (item) => item.tipo === "respuesta_generica"
        )
      ).toEqual([
        expect.objectContaining({
          severity: "menor",
          evidenceRefs: [{ source: "agent_message", index: 1 }],
        }),
      ]);
      expect(
        result.verdict.hallazgos.some((item) => item.tipo === "eco_cliente")
      ).toBe(false);
    }
  });
});

describe("Judge Quality v6 — grounding endurecido", () => {
  type Role = "cliente" | "agente";
  const GENERIC =
    "Claro, puedo ayudarte con eso. Dime qué información necesitas.";
  const DISCOUNT =
    "No manejamos descuentos o condiciones especiales de forma general. Si necesita más información sobre precios, puedo ayudarle a revisar las opciones disponibles.";
  const PRICE_EVIDENCE = "Limpieza dental: $700 MXN. Brackets desde $8,000 MXN.";
  const BUG_TRANSCRIPT: { role: Role; text: string }[] = [
    { role: "cliente", text: "Hola, ¿qué opciones manejan?" },
    { role: "agente", text: GENERIC },
    { role: "cliente", text: "¿Cuánto cuesta cada opción?" },
    { role: "agente", text: GENERIC },
  ];

  function finding(input: {
    tipo: "eco_cliente" | "repeticion" | "respuesta_generica";
    refs: number[];
    reason?: string;
    severity?: "menor" | "grave";
  }) {
    return {
      tipo: input.tipo,
      severity: input.severity ?? ("menor" as const),
      evidencia: "salida propuesta por el LLM",
      evidenceRefs: input.refs.map((index) => ({
        source: "agent_message" as const,
        index,
      })),
      reason: input.reason ?? "Propuesto por el LLM.",
    };
  }

  function judge(input: {
    hallazgos: ReturnType<typeof finding>[];
    transcript: { role: Role; text: string }[];
    evidenceText?: string;
  }) {
    return adjudicate({
      llmVerdict: { veredicto: "rojo", hallazgos: input.hallazgos },
      transcript: input.transcript,
      actionTrace: [],
      evidenceText: input.evidenceText,
    });
  }

  function summary(
    hallazgos: { tipo: string; severity: string; evidenceRefs: { index: number }[] }[]
  ) {
    return hallazgos.map(
      (item) =>
        `${item.tipo}/${item.severity}[${item.evidenceRefs.map((ref) => ref.index).join(",")}]`
    );
  }

  // TEST 1-3: el grounding no depende de cómo redacte `reason` el LLM.
  it.each([
    "El agente no respondió cuánto cuesta cada opción.",
    "No dio el valor ni la cotización de cada opción.",
    "No respondió cuánto sale cada servicio.",
  ])("rechaza respuesta_generica grave mal anclada a 0 con reason: %s", (reason) => {
    const proposed = finding({
      tipo: "respuesta_generica",
      refs: [0],
      severity: "grave",
      reason,
    });
    const result = judge({
      hallazgos: [proposed],
      transcript: BUG_TRANSCRIPT,
      evidenceText: PRICE_EVIDENCE,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rejectedFindings).toEqual([
        { finding: proposed, reason: "rejected_by_deterministic_grounding" },
      ]);
      expect(result.verdict.veredicto).toBe("amarillo");
      expect(summary(result.verdict.hallazgos)).toEqual([
        "respuesta_generica/menor[1]",
        "repeticion/menor[0,1]",
      ]);
    }
  });

  it("rechaza respuesta_generica si el turno citado no responde a una pregunta de precio, aunque el agente sea genérico", () => {
    const result = judge({
      hallazgos: [finding({ tipo: "respuesta_generica", refs: [0] })],
      transcript: BUG_TRANSCRIPT.slice(0, 2),
      evidenceText: PRICE_EVIDENCE,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict).toEqual({ veredicto: "verde", hallazgos: [] });
      expect(result.rejectedFindings).toHaveLength(1);
    }
  });

  // TEST 4
  it("acepta respuesta_generica correctamente anclada a la pregunta de precio, con severidad menor", () => {
    const proposed = finding({ tipo: "respuesta_generica", refs: [1] });
    const result = judge({
      hallazgos: [proposed],
      transcript: BUG_TRANSCRIPT,
      evidenceText: PRICE_EVIDENCE,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rejectedFindings).toHaveLength(0);
      expect(
        result.verdict.hallazgos.filter((item) => item.tipo === "respuesta_generica")
      ).toEqual([
        expect.objectContaining({
          severity: "menor",
          reason: proposed.reason,
          evidenceRefs: [{ source: "agent_message", index: 1 }],
        }),
      ]);
    }
  });

  it("rechaza respuesta_generica de precio si la evidencia no contiene precios", () => {
    const result = judge({
      hallazgos: [finding({ tipo: "respuesta_generica", refs: [1] })],
      transcript: BUG_TRANSCRIPT,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rejectedFindings).toHaveLength(1);
      expect(
        result.verdict.hallazgos.some((item) => item.tipo === "respuesta_generica")
      ).toBe(false);
    }
  });

  // TEST 5
  it.each(["respuesta_generica", "eco_cliente", "repeticion"] as const)(
    "normaliza %s grave del LLM a la severidad contractual menor sin volver rojo el caso",
    (tipo) => {
      const transcripts: Record<typeof tipo, { role: Role; text: string }[]> = {
        respuesta_generica: BUG_TRANSCRIPT,
        eco_cliente: [
          { role: "cliente", text: "Gracias, lo voy a revisar." },
          { role: "agente", text: "Gracias, lo voy a revisar." },
        ],
        repeticion: BUG_TRANSCRIPT,
      };
      const refs: Record<typeof tipo, number[]> = {
        respuesta_generica: [1],
        eco_cliente: [0],
        repeticion: [0, 1],
      };
      const proposed = finding({ tipo, refs: refs[tipo], severity: "grave" });
      const result = judge({
        hallazgos: [proposed],
        transcript: transcripts[tipo],
        evidenceText: PRICE_EVIDENCE,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.verdict.veredicto).toBe("amarillo");
        expect(result.rejectedFindings).toHaveLength(0);
        expect(
          result.verdict.hallazgos.every((item) => item.severity === "menor")
        ).toBe(true);
        expect(result.acceptedFindings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ tipo, severity: "menor", reason: proposed.reason }),
          ])
        );
      }
    }
  );

  // TEST 6-8: refs inválidas fallan antes del grounding, como en cualquier tipo.
  it.each([
    ["eco_cliente", [99], "agent_message=99"],
    ["repeticion", [99, 100], "agent_message=99"],
    ["respuesta_generica", [7], "agent_message=7"],
  ] as const)("%s con ref fuera de rango produce invalid_evidence_ref", (tipo, refs, detail) => {
    const result = judge({
      hallazgos: [finding({ tipo, refs: [...refs] })],
      transcript: BUG_TRANSCRIPT,
      evidenceText: PRICE_EVIDENCE,
    });

    expect(result).toEqual({
      ok: false,
      detail: `invalid_evidence_ref: hallazgo=0 ${detail}`,
    });
  });

  it("informa el índice crudo del hallazgo con ref inválida aunque un hallazgo previo se rechace", () => {
    const result = judge({
      hallazgos: [
        finding({ tipo: "eco_cliente", refs: [0] }),
        finding({ tipo: "repeticion", refs: [0, 9] }),
      ],
      transcript: BUG_TRANSCRIPT,
    });

    expect(result).toEqual({
      ok: false,
      detail: "invalid_evidence_ref: hallazgo=1 agent_message=9",
    });
  });

  // TEST 9-12
  it.each([
    ["[0,1] válido", [0, 1], true],
    ["[0,1,2] no es un par lógico", [0, 1, 2], false],
    ["[1,1] duplicado", [1, 1], false],
    ["[1,0] orden invertido", [1, 0], false],
  ] as const)("repeticion %s", (_label, refs, survives) => {
    const transcript: { role: Role; text: string }[] = [
      ...BUG_TRANSCRIPT,
      { role: "cliente", text: "¿Qué incluye cada una?" },
      { role: "agente", text: GENERIC },
    ];
    const proposed = finding({
      tipo: "repeticion",
      refs: [...refs],
      reason: "Repetición propuesta por el LLM.",
    });
    const result = judge({ hallazgos: [proposed], transcript });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rejectedFindings).toHaveLength(survives ? 0 : 1);
      expect(
        result.verdict.hallazgos.some((item) => item.reason === proposed.reason)
      ).toBe(survives);
    }
  });

  it("acepta repeticion [0,2] cuando hay un mensaje nuevo del cliente entre ambas", () => {
    const result = judge({
      hallazgos: [finding({ tipo: "repeticion", refs: [0, 2] })],
      transcript: [
        { role: "cliente", text: "Hola" },
        { role: "agente", text: GENERIC },
        { role: "cliente", text: "¿Qué opciones manejan?" },
        { role: "agente", text: "Manejamos limpieza dental y brackets." },
        { role: "cliente", text: "¿Qué incluye cada una?" },
        { role: "agente", text: GENERIC },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rejectedFindings).toHaveLength(0);
      expect(summary(result.verdict.hallazgos)).toEqual(["repeticion/menor[0,2]"]);
    }
  });

  it("rechaza repeticion sin un mensaje nuevo del cliente antes de la segunda respuesta", () => {
    const result = judge({
      hallazgos: [finding({ tipo: "repeticion", refs: [0, 1] })],
      transcript: [
        { role: "cliente", text: "Hola" },
        { role: "agente", text: GENERIC },
        { role: "agente", text: GENERIC },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict).toEqual({ veredicto: "verde", hallazgos: [] });
      expect(result.rejectedFindings).toHaveLength(1);
    }
  });

  // TEST 13
  it("rechaza repeticion de una fórmula trivial por debajo del mínimo del determinista", () => {
    const result = judge({
      hallazgos: [finding({ tipo: "repeticion", refs: [0, 1] })],
      transcript: [
        { role: "cliente", text: "Hola" },
        { role: "agente", text: "¡Claro!" },
        { role: "cliente", text: "Ok" },
        { role: "agente", text: "¡Claro!" },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict).toEqual({ veredicto: "verde", hallazgos: [] });
      expect(result.rejectedFindings).toHaveLength(1);
    }
  });

  // TEST 14
  it("una repeticion LLM [0,1] no impide que el backend añada la repeticion [0,2]", () => {
    const proposed = finding({
      tipo: "repeticion",
      refs: [0, 1],
      reason: "Repetición propuesta por el LLM.",
    });
    const result = judge({
      hallazgos: [proposed],
      transcript: [
        { role: "cliente", text: "Hola, ¿qué opciones manejan?" },
        { role: "agente", text: GENERIC },
        { role: "cliente", text: "¿Qué incluye cada opción?" },
        { role: "agente", text: GENERIC },
        { role: "cliente", text: "¿Y los horarios?" },
        { role: "agente", text: GENERIC },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const repetitions = result.verdict.hallazgos.filter(
        (item) => item.tipo === "repeticion"
      );
      expect(summary(repetitions)).toEqual([
        "repeticion/menor[0,1]",
        "repeticion/menor[0,2]",
      ]);
      expect(repetitions[0]!.reason).toBe(proposed.reason);
    }
  });

  // TEST 15
  it("respuesta_generica y repeticion legítimas coexisten sobre el mismo turno actual", () => {
    const result = judge({
      hallazgos: [
        finding({ tipo: "respuesta_generica", refs: [1] }),
        finding({ tipo: "repeticion", refs: [0, 1] }),
      ],
      transcript: BUG_TRANSCRIPT,
      evidenceText: PRICE_EVIDENCE,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rejectedFindings).toHaveLength(0);
      expect(summary(result.verdict.hallazgos)).toEqual([
        "respuesta_generica/menor[1]",
        "repeticion/menor[0,1]",
      ]);
    }
  });

  // TEST 16
  it("un hallazgo LLM rechazado en el mismo índice no bloquea la respuesta_generica determinista", () => {
    const result = judge({
      hallazgos: [finding({ tipo: "eco_cliente", refs: [1], severity: "grave" })],
      transcript: [
        { role: "cliente", text: "Hola" },
        { role: "agente", text: "Hola, bienvenido a la clínica dental." },
        { role: "cliente", text: "¿Cuánto cobran por la limpieza?" },
        { role: "agente", text: GENERIC },
      ],
      evidenceText: PRICE_EVIDENCE,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rejectedFindings.map((item) => item.finding.tipo)).toEqual([
        "eco_cliente",
      ]);
      expect(result.verdict.veredicto).toBe("amarillo");
      expect(summary(result.verdict.hallazgos)).toEqual([
        "respuesta_generica/menor[1]",
      ]);
    }
  });

  it("varios hallazgos LLM rechazados en el mismo turno no bloquean la repeticion determinista", () => {
    const result = judge({
      hallazgos: [
        finding({ tipo: "respuesta_generica", refs: [1] }),
        finding({ tipo: "eco_cliente", refs: [1] }),
        finding({ tipo: "repeticion", refs: [1, 2] }),
      ],
      transcript: [
        ...BUG_TRANSCRIPT,
        { role: "cliente", text: "¿Me lo puede repetir?" },
        { role: "agente", text: GENERIC },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Sin precios en la evidencia la genérica no es verificable, el eco es
      // falso y [1,2] responde a un pedido de repetir: los tres se rechazan y
      // la repetición determinista [0,1] sigue apareciendo.
      expect(result.rejectedFindings).toHaveLength(3);
      expect(summary(result.verdict.hallazgos)).toEqual(["repeticion/menor[0,1]"]);
    }
  });

  it("conserva el eco real y rechaza el falso eco del descuento", () => {
    const result = judge({
      hallazgos: [
        finding({ tipo: "eco_cliente", refs: [0] }),
        finding({ tipo: "eco_cliente", refs: [1] }),
      ],
      transcript: [
        { role: "cliente", text: "¿Tienen algún descuento o condición especial?" },
        { role: "agente", text: DISCOUNT },
        { role: "cliente", text: "Gracias, lo voy a revisar." },
        { role: "agente", text: "Gracias, lo voy a revisar." },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.rejectedFindings.map((item) => item.finding.evidenceRefs)
      ).toEqual([[{ source: "agent_message", index: 0 }]]);
      expect(summary(result.verdict.hallazgos)).toEqual(["eco_cliente/menor[1]"]);
    }
  });

  it.each([
    ["¿Cuánto cobran por la limpieza?", true],
    ["¿Me pasa una cotización de brackets?", true],
    ["¿Cuánto vale la consulta?", true],
    ["¿Cuáles son sus tarifas?", true],
    ["¿Qué opciones manejan?", false],
    ["¿A qué hora sale el doctor?", false],
    ["¿Cuál es el valor nutricional?", false],
  ])("detecta pregunta de precio de forma conservadora: %s → %s", (question, detected) => {
    const result = judge({
      hallazgos: [],
      transcript: [
        { role: "cliente", text: question },
        { role: "agente", text: GENERIC },
      ],
      evidenceText: PRICE_EVIDENCE,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.verdict.hallazgos.some((item) => item.tipo === "respuesta_generica")
      ).toBe(detected);
    }
  });

  it("regresión de producción: paráfrasis sin 'precio', falso eco y repeticiones reales", () => {
    const invalidGeneric = finding({
      tipo: "respuesta_generica",
      refs: [0],
      severity: "grave",
      reason: "El agente no respondió cuánto cuesta cada opción.",
    });
    const invalidEcho = finding({
      tipo: "eco_cliente",
      refs: [3],
      reason: "El agente repitió información sin avanzar la conversación.",
    });
    const repetition01 = finding({
      tipo: "repeticion",
      refs: [0, 1],
      severity: "grave",
      reason: "Repetición exacta entre los turnos 0 y 1.",
    });
    const result = judge({
      hallazgos: [invalidGeneric, invalidEcho, repetition01],
      transcript: [
        { role: "cliente", text: "Hola, ¿qué opciones manejan?" },
        { role: "agente", text: GENERIC },
        { role: "cliente", text: "¿Cuánto cuesta cada opción?" },
        { role: "agente", text: GENERIC },
        { role: "cliente", text: "¿Qué incluye cada una?" },
        { role: "agente", text: GENERIC },
        { role: "cliente", text: "¿Tienen algún descuento o condición especial?" },
        { role: "agente", text: DISCOUNT },
        { role: "cliente", text: "Gracias, lo voy a revisar." },
        { role: "agente", text: DISCOUNT },
      ],
      evidenceText: PRICE_EVIDENCE,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rejectedFindings).toEqual([
        { finding: invalidGeneric, reason: "rejected_by_deterministic_grounding" },
        { finding: invalidEcho, reason: "rejected_by_deterministic_grounding" },
      ]);
      expect(result.verdict.veredicto).toBe("amarillo");
      expect(summary(result.verdict.hallazgos)).toEqual([
        "respuesta_generica/menor[1]",
        "repeticion/menor[0,1]",
        "repeticion/menor[0,2]",
        "repeticion/menor[3,4]",
      ]);
      expect(result.acceptedFindings).toBe(result.verdict.hallazgos);
    }
  });
});

describe("judgeCase (FR-032)", () => {
  beforeEach(() => chatJson.mockReset());

  it("no permite verde cuando una respuesta genérica evade una pregunta concreta de precio respaldada por KB", async () => {
    chatJson.mockResolvedValue({
      ok: true,
      data: {
        veredicto: "verde",
        hallazgos: [],
      },
      raw: "{}",
    });

    const outcome = await judgeCase({
      personaKey: "pregunton_precios",
      transcript: [
        { role: "cliente", text: "¿Cuánto cuesta cada opción?" },
        {
          role: "agente",
          text: "Claro, puedo ayudarte con eso. Dime qué información necesitas.",
        },
      ],
      kbText:
        "Limpieza dental: $700 MXN. Incluye evaluación y procedimiento de limpieza.",
      behaviorText:
        "Responde preguntas comerciales con la información disponible.",
      actionTrace: [],
    });

    expect(outcome.status).toBe("done");

    if (outcome.status === "done") {
      expect(outcome.verdict.veredicto).toBe("amarillo");
      expect(outcome.verdict.hallazgos).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tipo: "respuesta_generica",
            severity: "menor",
          }),
        ])
      );
    }
  });

  it("no permite verde cuando el agente sólo hace eco del mensaje del cliente", async () => {
    chatJson.mockResolvedValue({
      ok: true,
      data: {
        veredicto: "verde",
        hallazgos: [],
      },
      raw: "{}",
    });

    const outcome = await judgeCase({
      personaKey: "comprador_decidido",
      transcript: [
        {
          role: "cliente",
          text: "Quiero información sobre la limpieza dental para mañana.",
        },
        {
          role: "agente",
          text: "Entiendo que quieres información sobre la limpieza dental para mañana.",
        },
      ],
      kbText: "Limpieza dental: $700 MXN.",
      behaviorText: "Responde la pregunta y ayuda a avanzar.",
      actionTrace: [],
    });

    expect(outcome.status).toBe("done");

    if (outcome.status === "done") {
      expect(outcome.verdict.veredicto).toBe("amarillo");
      expect(outcome.verdict.hallazgos).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tipo: "eco_cliente",
            severity: "menor",
            evidenceRefs: [{ source: "agent_message", index: 0 }],
          }),
        ])
      );
    }
  });

  it("mantiene verde cuando confirma lo entendido y aporta una respuesta útil", async () => {
    chatJson.mockResolvedValue({
      ok: true,
      data: {
        veredicto: "verde",
        hallazgos: [],
      },
      raw: "{}",
    });

    const outcome = await judgeCase({
      personaKey: "comprador_decidido",
      transcript: [
        {
          role: "cliente",
          text: "Quiero información sobre la limpieza dental para mañana.",
        },
        {
          role: "agente",
          text: "Entiendo que quieres información sobre la limpieza dental para mañana. Tiene un precio de $700 MXN e incluye evaluación y limpieza.",
        },
      ],
      kbText: "Limpieza dental: $700 MXN. Incluye evaluación y limpieza.",
      behaviorText: "Responde la pregunta y ayuda a avanzar.",
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

  it("no permite verde cuando el agente repite exactamente una respuesta anterior sin que el cliente lo pida", async () => {
    chatJson.mockResolvedValue({
      ok: true,
      data: {
        veredicto: "verde",
        hallazgos: [],
      },
      raw: "{}",
    });

    const repeated =
      "No tengo información sobre descuentos o condiciones especiales. Puedo consultar esto con el equipo y responderle.";

    const outcome = await judgeCase({
      personaKey: "pregunton_precios",
      transcript: [
        {
          role: "cliente",
          text: "¿Tienen algún descuento o condición especial?",
        },
        { role: "agente", text: repeated },
        { role: "cliente", text: "Gracias, lo voy a revisar." },
        { role: "agente", text: repeated },
      ],
      kbText: "",
      behaviorText: "",
      actionTrace: [],
    });

    expect(outcome.status).toBe("done");

    if (outcome.status === "done") {
      expect(outcome.verdict.veredicto).toBe("amarillo");
      expect(outcome.verdict.hallazgos).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tipo: "repeticion",
            severity: "menor",
            evidenceRefs: [
              { source: "agent_message", index: 0 },
              { source: "agent_message", index: 1 },
            ],
          }),
        ])
      );
    }
  });

  it("permite repetir exactamente una respuesta cuando el cliente lo pide", async () => {
    chatJson.mockResolvedValue({
      ok: true,
      data: {
        veredicto: "verde",
        hallazgos: [],
      },
      raw: "{}",
    });

    const repeated = "La limpieza dental tiene un precio de $700 MXN.";

    const outcome = await judgeCase({
      personaKey: "pregunton_precios",
      transcript: [
        { role: "cliente", text: "¿Cuánto cuesta la limpieza?" },
        { role: "agente", text: repeated },
        { role: "cliente", text: "¿Me lo puedes decir otra vez?" },
        { role: "agente", text: repeated },
      ],
      kbText: "Limpieza dental: $700 MXN.",
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
              reason:
                "El agente transfirió una consulta comercial que podía continuar.",
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
        behaviorText:
          "Responde consultas comerciales con la información disponible.",
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
        expect(outcome.verdict.hallazgos[0]?.tipo).toBe(
          "handoff_innecesario"
        );
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
    const verdes = Array(6).fill({
      status: "done",
      veredicto: "verde",
    });

    const rojos = Array(6).fill({
      status: "done",
      veredicto: "rojo",
    });

    expect(computeScore(verdes)).toBe(100);
    expect(computeScore(rojos)).toBe(0);
  });
});

describe("evidencia de disponibilidad de agenda", () => {
  it("elimina alucinacion cuando el horario proviene de offer_slots real", async () => {
    chatJson.mockResolvedValue({
      ok: true,
      data: {
        veredicto: "rojo",
        hallazgos: [
          {
            tipo: "alucinacion",
            severity: "grave",
            evidencia: "horarios inventados",
            evidenceRefs: [{ source: "agent_message", index: 0 }],
            reason: "El juez creyó que la disponibilidad fue inventada.",
          },
        ],
      },
      raw: "{}",
    });

    const availability =
      "Tengo estos horarios disponibles:\\nHoy viernes, 2 de octubre\\n• 09:00\\n• 09:30\\n• 10:00";

    const outcome = await judgeCase({
      personaKey: "comprador_decidido",
      transcript: [
        {
          role: "cliente",
          text: "Perfecto, quiero avanzar hoy. ¿Cuál es el siguiente paso?",
        },
        {
          role: "agente",
          text: availability,
        },
      ],
      kbText: "",
      behaviorText: "",
      agendaEnabled: true,
      actionTrace: [
        {
          turn: 1,
          customerMessage:
            "Perfecto, quiero avanzar hoy. ¿Cuál es el siguiente paso?",
          agentMessages: [availability],
          observedActions: ["reply", "offer_slots"],
          result: {
            handoffReason: null,
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

  it("mantiene alucinacion si el horario no tiene offer_slots real", async () => {
    chatJson.mockResolvedValue({
      ok: true,
      data: {
        veredicto: "rojo",
        hallazgos: [
          {
            tipo: "alucinacion",
            severity: "grave",
            evidencia: "horarios inventados",
            evidenceRefs: [{ source: "agent_message", index: 0 }],
            reason: "La disponibilidad no está respaldada por el backend.",
          },
        ],
      },
      raw: "{}",
    });

    const availability =
      "Tengo estos horarios disponibles: 09:00, 09:30 y 10:00.";

    const outcome = await judgeCase({
      personaKey: "comprador_decidido",
      transcript: [
        {
          role: "cliente",
          text: "¿Qué horarios hay?",
        },
        {
          role: "agente",
          text: availability,
        },
      ],
      kbText: "",
      behaviorText: "",
      agendaEnabled: true,
      actionTrace: [
        {
          turn: 1,
          customerMessage: "¿Qué horarios hay?",
          agentMessages: [availability],
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

    expect(outcome.status).toBe("done");

    if (outcome.status === "done") {
      expect(outcome.verdict.veredicto).toBe("rojo");
      expect(outcome.verdict.hallazgos[0]?.tipo).toBe("alucinacion");
    }
  });
});
