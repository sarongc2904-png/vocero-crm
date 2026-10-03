import { describe, expect, it } from "vitest";
import { groundedConversationReply } from "@/server/ai/prompts";
import { sameNormalizedMessage } from "@/server/ai/handoff";

/**
 * Lab 3282b17 ("Comprador decidido"): el agente repitió en el turno 4 la misma
 * pregunta del turno 2 porque entre ambos el modelo pidió los datos con una
 * AFIRMACIÓN (sin "?") y la anti-repetición solo miraba el último mensaje.
 * Además "procedimiento" en las preguntas frecuentes apagaba la abstención de
 * "qué incluye", y el modelo devolvió una lista parcial de precios.
 */

// Documento demo completo (estructura real de Clínica Dental Sonrisa Plus).
const DEMO_PRICE_LINES = [
  "- Consulta de valoración: $300 MXN",
  "- Limpieza dental: $700 MXN",
  "- Resina dental: desde $800 MXN por pieza",
  "- Blanqueamiento dental: desde $2,500 MXN",
  "- Extracción simple: desde $900 MXN",
  "- Extracción de muela del juicio: desde $2,500 MXN",
  "- Ortodoncia: valoración inicial $500 MXN",
  "- Brackets metálicos: desde $8,000 MXN",
  "- Endodoncia: desde $3,000 MXN",
  "- Corona dental: desde $4,500 MXN",
];
const DEMO_DOCUMENT = [
  "CLÍNICA DENTAL SONRISA PLUS",
  "1. INFORMACIÓN GENERAL",
  "Clínica Dental Sonrisa Plus ofrece atención dental para adultos y niños.",
  "2. SERVICIOS Y PRECIOS DE REFERENCIA",
  ...DEMO_PRICE_LINES,
  "Los precios son de referencia y pueden cambiar después de la valoración clínica.",
  "4. CITAS",
  "Para agendar una cita solicitar:",
  "- Nombre completo",
  "- Número de teléfono",
  "- Servicio o motivo de consulta",
  "- Día y horario preferido",
  "9. PREGUNTAS FRECUENTES",
  "Pregunta: ¿Cuánto cuesta una limpieza?",
  "Respuesta: La limpieza dental tiene un precio de referencia de $700 MXN. Si durante la valoración se requiere un procedimiento adicional, el dentista se lo explicará antes de realizarlo.",
  "Pregunta: ¿Hacen extracciones?",
  "Respuesta: Sí. Realizamos extracciones simples y valoramos casos de muelas del juicio. El costo depende del tipo de procedimiento.",
].join("\n");

const ASK_NAME = "Para avanzar, ¿me comparte su nombre completo?";
const ASK_NAME_INFORMAL = "Para avanzar, ¿me compartes tu nombre completo?";
const MODEL_STATEMENT =
  "Para empezar, necesito su nombre completo, número de teléfono, servicio o motivo de consulta, y día y horario preferido.";

type Turn = { role: "agent" | "customer"; text: string };

function reply(conversation: Turn[], tone?: string | null, knowledge = DEMO_DOCUMENT) {
  const current = conversation[conversation.length - 1]!;
  return groundedConversationReply({
    inboundText: current.text,
    customerHistoryText: conversation
      .filter((turn) => turn.role === "customer")
      .map((turn) => turn.text)
      .join("\n"),
    knowledgeText: knowledge,
    tone,
    lastAgentText:
      [...conversation.slice(0, -1)].reverse().find((turn) => turn.role === "agent")?.text ?? null,
    conversation,
  });
}

function agentTexts(conversation: Turn[]): string[] {
  return conversation.filter((turn) => turn.role === "agent").map((turn) => turn.text);
}

describe("reproducción del Lab — sin repetir ningún mensaje previo del agente", () => {
  const TURN1: Turn[] = [
    { role: "customer", text: "Hola, me interesa lo que ofrecen." },
    {
      role: "agent",
      text: "¡Hola! Gracias por su interés en nuestros servicios. ¿En qué puedo ayudarle específicamente?",
    },
  ];
  const TURN2_TEXT =
    "Ya revisé la información y quiero contratar o comprar la opción que más me convenga";

  it("turno 2 pide el nombre", () => {
    expect(reply([...TURN1, { role: "customer", text: TURN2_TEXT }])).toBe(ASK_NAME);
  });

  it("turno 4 no repite ningún mensaje previo y pide los datos juntos", () => {
    const conversation: Turn[] = [
      ...TURN1,
      { role: "customer", text: TURN2_TEXT },
      { role: "agent", text: ASK_NAME },
      { role: "customer", text: "¿Cuánto cuesta y qué necesito para empezar?" },
      { role: "agent", text: MODEL_STATEMENT },
      { role: "customer", text: "Perfecto, quiero avanzar hoy. ¿Cuál es el siguiente paso?" },
    ];
    const answer = reply(conversation);

    expect(answer).not.toBeNull();
    for (const previous of agentTexts(conversation)) {
      expect(sameNormalizedMessage(answer!, previous)).toBe(false);
    }
    expect(answer).toMatch(/nombre completo/);
    expect(answer).toMatch(/tel[eé]fono/);
    expect(answer).toMatch(/servicio o motivo/);
    expect(answer).toMatch(/\bsu\b/);
  });

  it("en tono informal tampoco repite y usa tú", () => {
    const conversation: Turn[] = [
      { role: "customer", text: TURN2_TEXT },
      { role: "agent", text: ASK_NAME_INFORMAL },
      { role: "customer", text: "¿Cuánto cuesta y qué necesito para empezar?" },
      { role: "agent", text: "Para empezar, necesito tu nombre completo y tu teléfono." },
      { role: "customer", text: "Perfecto, quiero avanzar hoy" },
    ];
    const answer = reply(conversation, "informal");
    for (const previous of agentTexts(conversation)) {
      expect(sameNormalizedMessage(answer!, previous)).toBe(false);
    }
    expect(answer).toMatch(/\btu\b/);
    expect(answer).not.toMatch(/\bsu\b/);
  });

  it("si la pregunta y la combinada ya se enviaron, usa otra formulación; luego una tercera", () => {
    const base: Turn[] = [
      { role: "customer", text: "Quiero avanzar hoy" },
      { role: "agent", text: ASK_NAME },
      { role: "customer", text: "Quiero avanzar hoy" },
    ];
    const combinedA = reply(base)!;
    const afterA: Turn[] = [
      ...base,
      { role: "agent", text: combinedA },
      { role: "customer", text: "Ok" },
      { role: "agent", text: "Con gusto." },
      { role: "customer", text: "Quiero avanzar hoy" },
    ];
    const combinedB = reply(afterA)!;
    expect(combinedB).not.toBe(combinedA);

    const afterB: Turn[] = [
      ...afterA,
      { role: "agent", text: combinedB },
      { role: "customer", text: "Quiero avanzar ya" },
    ];
    const third = reply(afterB)!;
    expect(third).toMatch(/^Entiendo\./);
    for (const previous of agentTexts(afterB)) {
      expect(sameNormalizedMessage(third, previous)).toBe(false);
    }

    const afterThird: Turn[] = [
      ...afterB,
      { role: "agent", text: third },
      { role: "customer", text: "Quiero avanzar hoy" },
    ];
    // Agotadas las formulaciones, la regla no devuelve un texto ya enviado:
    // la respuesta queda al modelo.
    expect(reply(afterThird)).toBeNull();
  });
});

describe("una afirmación que pide el nombre también cuenta", () => {
  it.each([
    MODEL_STATEMENT,
    "Para avanzar necesito su nombre completo.",
    "Me comparte su nombre completo, por favor.",
  ])("tras '%s', 'Juan Pérez' cuenta como nombre y se pide el teléfono", (statement) => {
    expect(
      reply([
        { role: "customer", text: "Quiero avanzar hoy" },
        { role: "agent", text: statement },
        { role: "customer", text: "Juan Pérez" },
      ])
    ).toBe("Gracias. ¿Me comparte su número de teléfono?");
  });

  it("un mensaje que solo menciona 'nombre' sin pedirlo no cuenta", () => {
    expect(
      reply([
        { role: "customer", text: "Quiero avanzar hoy" },
        { role: "agent", text: "Gracias, ya registré su nombre." },
        { role: "customer", text: "Juan Pérez" },
      ])
    ).toBeNull();
  });
});

describe("falsos nombres: solo cuenta lo que responde a una petición del nombre", () => {
  const PHONE_ASK = "Gracias. ¿Me comparte su número de teléfono?";
  const OPEN_QUESTION = "Dígame, ¿en qué le ayudo?";

  // ¿La respuesta directa a la pregunta del agente se toma como nombre?
  function directAnswer(agentText: string, customerText: string) {
    return reply([
      { role: "customer", text: "Quiero avanzar hoy" },
      { role: "agent", text: agentText },
      { role: "customer", text: customerText },
    ]);
  }

  // ¿Queda registrada como nombre en el historial para una insistencia posterior?
  function laterInsistence(agentText: string, customerText: string) {
    return reply([
      { role: "customer", text: "Hola" },
      { role: "agent", text: agentText },
      { role: "customer", text: customerText },
      { role: "agent", text: "Con gusto." },
      { role: "customer", text: "Quiero avanzar hoy" },
    ]);
  }

  it.each(["Buenas tardes", "Limpieza dental"])(
    "tras '%s' del agente sin pedir nombre… ('Dígame, ¿en qué le ayudo?' + '%s') NO es nombre",
    (customerText) => {
      expect(directAnswer(OPEN_QUESTION, customerText)).toBeNull();
      expect(laterInsistence(OPEN_QUESTION, customerText)).toMatch(/nombre/);
    }
  );

  it.each([
    "Limpieza dental",
    "Ortodoncia",
    "Corona dental",
    "Resina dental",
    "Extracción simple",
    "Brackets metálicos",
  ])("tras pedir el nombre, el servicio de la KB '%s' NO es nombre", (service) => {
    expect(directAnswer(ASK_NAME, service)).not.toBe(PHONE_ASK);
    expect(laterInsistence(ASK_NAME, service)).toMatch(/nombre/);
  });

  it.each(["Pedro Corona", "María Resina", "Ana Ortodoncia Ruiz"])(
    "'%s' (comparte un apellido con un servicio) SÍ cuenta como nombre",
    (name) => {
      expect(directAnswer(ASK_NAME, name)).toBe(PHONE_ASK);
      expect(laterInsistence(ASK_NAME, name)).not.toMatch(/nombre/);
    }
  );

  it.each(["Corona dental", "Corona", "Extracción simple", "Brackets metálicos", "Dental corona"])(
    "'%s' (solo palabras de un servicio) NO cuenta como nombre",
    (service) => {
      expect(directAnswer(ASK_NAME, service)).not.toBe(PHONE_ASK);
      expect(laterInsistence(ASK_NAME, service)).toMatch(/nombre/);
    }
  );

  it("control: tras 'necesito su nombre completo', 'Juan Pérez' SÍ es nombre", () => {
    expect(directAnswer("Para continuar necesito su nombre completo.", "Juan Pérez")).toBe(PHONE_ASK);
    expect(laterInsistence("Para continuar necesito su nombre completo.", "Juan Pérez")).not.toMatch(
      /nombre/
    );
  });
});

describe("'procedimiento' en preguntas frecuentes no apaga la abstención", () => {
  it.each([
    ["me dice cuanto sale y q incluye?", null],
    ["me dice cuanto sale y q incluye?", "informal"],
  ] as const)("'%s' (tono %s) devuelve las 10 líneas y la abstención", (text, tone) => {
    const answer = reply([{ role: "customer", text }], tone);
    expect(answer).not.toBeNull();
    for (const line of DEMO_PRICE_LINES) expect(answer).toContain(line);
    expect(answer).toMatch(/no detalla qu[eé] incluye/);
    expect(answer).toMatch(tone === "informal" ? /si quieres/ : /si lo desea/);
  });

  it("'¿Qué incluye cada una?' devuelve la abstención", () => {
    const answer = reply([{ role: "customer", text: "¿Qué incluye cada una?" }]);
    expect(answer).toMatch(/no detalla qu[eé] incluye cada servicio/);
  });

  it("'La limpieza incluye revisión y pulido' sigue contando como detalle: la regla no interviene", () => {
    const knowledge = `${DEMO_DOCUMENT}\nLa limpieza incluye revisión y pulido.`;
    expect(reply([{ role: "customer", text: "me dice cuanto sale y q incluye?" }], null, knowledge)).toBeNull();
    expect(reply([{ role: "customer", text: "¿Qué incluye cada una?" }], null, knowledge)).toBeNull();
  });
});
