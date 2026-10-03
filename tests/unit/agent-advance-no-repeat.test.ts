import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groundedConversationReply } from "@/server/ai/prompts";
import { isClosingAcknowledgement } from "@/server/ai/handoff";

/**
 * Lab "Comprador decidido": ante dos "quiero avanzar hoy" seguidos sin nombre
 * en el historial, el agente repetía literalmente "Para avanzar, ¿me comparte
 * su nombre completo?". Además un "Juan Pérez" en respuesta a esa pregunta no
 * contaba como nombre, y "me dice cuanto sale y q incluye?" caía al modelo,
 * que prometía información inexistente sobre lo que incluye cada servicio.
 */

const KNOWLEDGE = [
  "2. SERVICIOS Y PRECIOS DE REFERENCIA",
  "- Consulta de valoración: $300 MXN",
  "- Limpieza dental: $700 MXN",
  "- Brackets metálicos: desde $8,000 MXN",
  "Los precios son de referencia y pueden cambiar después de la valoración clínica.",
  "4. CITAS",
  "Para agendar una cita solicitar:",
  "- Nombre completo",
  "- Número de teléfono",
  "- Servicio o motivo de consulta",
  "- Día y horario preferido",
].join("\n");

const ASK_NAME = "Para avanzar, ¿me comparte su nombre completo?";
const ASK_NAME_INFORMAL = "Para avanzar, ¿me compartes tu nombre completo?";

type Turn = { role: "agent" | "customer"; text: string };

function reply(input: {
  inbound: string;
  conversation: Turn[];
  tone?: string | null;
  knowledge?: string;
}) {
  const customerHistoryText = input.conversation
    .filter((turn) => turn.role === "customer")
    .map((turn) => turn.text)
    .join("\n");
  const lastAgentText =
    [...input.conversation]
      .slice(0, -1)
      .reverse()
      .find((turn) => turn.role === "agent")?.text ?? null;
  return groundedConversationReply({
    inboundText: input.inbound,
    customerHistoryText,
    knowledgeText: input.knowledge ?? KNOWLEDGE,
    tone: input.tone,
    lastAgentText,
    conversation: input.conversation,
  });
}

describe("intención fuerte de compra — sin repetir la misma pregunta", () => {
  it("dos 'quiero avanzar hoy' seguidos: la segunda respuesta cambia y pide los tres datos", () => {
    const first = reply({
      inbound: "Quiero avanzar hoy",
      conversation: [{ role: "customer", text: "Quiero avanzar hoy" }],
    });
    expect(first).toBe(ASK_NAME);

    const second = reply({
      inbound: "Perfecto, quiero avanzar hoy",
      conversation: [
        { role: "customer", text: "Quiero avanzar hoy" },
        { role: "agent", text: first! },
        { role: "customer", text: "Perfecto, quiero avanzar hoy" },
      ],
    });
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(second).toMatch(/nombre completo/);
    expect(second).toMatch(/tel[eé]fono/);
    expect(second).toMatch(/servicio o motivo/);
    expect(second).toMatch(/\bsu\b/);
    expect(second).not.toMatch(/\btu\b|compartes/);
  });

  it("también evita repetir si la pregunta previa del agente pedía el nombre con otras palabras", () => {
    const second = reply({
      inbound: "Quiero avanzar hoy",
      conversation: [
        { role: "customer", text: "Quiero contratar" },
        { role: "agent", text: "Con gusto. ¿Cuál es su nombre completo?" },
        { role: "customer", text: "Quiero avanzar hoy" },
      ],
    });
    expect(second).not.toBe(ASK_NAME);
    expect(second).toMatch(/nombre completo/);
    expect(second).toMatch(/tel[eé]fono/);
  });

  it("solo pide los datos que faltan en la petición combinada", () => {
    const second = reply({
      inbound: "Quiero avanzar hoy",
      conversation: [
        { role: "customer", text: "Me interesa la limpieza dental" },
        { role: "agent", text: ASK_NAME },
        { role: "customer", text: "Quiero avanzar hoy" },
      ],
    });
    expect(second).toMatch(/nombre completo/);
    expect(second).toMatch(/tel[eé]fono/);
    expect(second).not.toMatch(/servicio o motivo/);
  });

  it("una tercera insistencia tampoco repite la petición combinada", () => {
    const combined = reply({
      inbound: "Quiero avanzar hoy",
      conversation: [
        { role: "customer", text: "Quiero avanzar hoy" },
        { role: "agent", text: ASK_NAME },
        { role: "customer", text: "Quiero avanzar hoy" },
      ],
    })!;
    const third = reply({
      inbound: "Quiero avanzar ya",
      conversation: [
        { role: "customer", text: "Quiero avanzar hoy" },
        { role: "agent", text: ASK_NAME },
        { role: "customer", text: "Quiero avanzar hoy" },
        { role: "agent", text: combined },
        { role: "customer", text: "Quiero avanzar ya" },
      ],
    });
    expect(third).not.toBe(combined);
    expect(third).toMatch(/nombre/);
  });

  it("respeta el tuteo cuando el tono lo pide", () => {
    const second = reply({
      inbound: "Quiero avanzar hoy",
      tone: "Cercano, tutea al cliente",
      conversation: [
        { role: "customer", text: "Quiero avanzar hoy" },
        { role: "agent", text: ASK_NAME_INFORMAL },
        { role: "customer", text: "Quiero avanzar hoy" },
      ],
    });
    expect(second).not.toBe(ASK_NAME_INFORMAL);
    expect(second).toMatch(/\btu\b/);
    expect(second).toMatch(/tel[eé]fono/);
    expect(second).not.toMatch(/\bsu\b/);
  });
});

describe("detección de nombre como respuesta a la pregunta del agente", () => {
  it("'Juan Pérez' tras pedir el nombre cuenta como nombre y lo siguiente es el teléfono", () => {
    const next = reply({
      inbound: "Juan Pérez",
      conversation: [
        { role: "customer", text: "Quiero avanzar hoy" },
        { role: "agent", text: ASK_NAME },
        { role: "customer", text: "Juan Pérez" },
      ],
    });
    expect(next).toBe("Gracias. ¿Me comparte su número de teléfono?");
  });

  it("el nombre dado antes sigue contando cuando el cliente vuelve a insistir", () => {
    const next = reply({
      inbound: "Quiero avanzar hoy",
      conversation: [
        { role: "customer", text: "Quiero avanzar hoy" },
        { role: "agent", text: ASK_NAME },
        { role: "customer", text: "María José López" },
        { role: "agent", text: "Gracias. ¿Me comparte su número de teléfono?" },
        { role: "customer", text: "Quiero avanzar hoy" },
      ],
    });
    expect(next).not.toMatch(/nombre/);
    expect(next).toMatch(/tel[eé]fono/);
  });

  it.each([
    "¿Cuánto cuesta?",
    "quiero el precio",
    "cuánto sale la limpieza",
    "va gracias",
    "Juan",
    "no sé todavía mañana le digo",
  ])("'%s' tras pedir el nombre NO cuenta como nombre", (text) => {
    const next = reply({
      inbound: "Quiero avanzar hoy",
      conversation: [
        { role: "customer", text: "Quiero avanzar hoy" },
        { role: "agent", text: ASK_NAME },
        { role: "customer", text },
        { role: "agent", text: "Con gusto." },
        { role: "customer", text: "Quiero avanzar hoy" },
      ],
    });
    expect(next).toMatch(/nombre/);
  });

  it("mantiene 'me llamo', 'mi nombre es' y 'soy', pero no 'soy de <ciudad>'", () => {
    const base = (history: string) =>
      groundedConversationReply({
        inboundText: "Quiero avanzar hoy",
        customerHistoryText: `${history}\nQuiero avanzar hoy`,
        knowledgeText: KNOWLEDGE,
      });
    expect(base("Me llamo Juan Pérez")).toMatch(/tel[eé]fono/);
    expect(base("Mi nombre es Ana Ruiz")).toMatch(/tel[eé]fono/);
    expect(base("Soy Juan Pérez")).toMatch(/tel[eé]fono/);
    expect(base("Soy de Monterrey")).toBe(ASK_NAME);
    expect(base("Soy del centro")).toBe(ASK_NAME);
  });

  it("'Gracias, me llamo Juan Pérez' no es un cierre y no lo resuelve la regla determinista", () => {
    expect(isClosingAcknowledgement("Gracias, me llamo Juan Pérez", ASK_NAME)).toBe(false);
    expect(
      reply({
        inbound: "Gracias, me llamo Juan Pérez",
        conversation: [
          { role: "customer", text: "Quiero avanzar hoy" },
          { role: "agent", text: ASK_NAME },
          { role: "customer", text: "Gracias, me llamo Juan Pérez" },
        ],
      })
    ).toBeNull();
  });

  it.each(["gracias, lo voy a revisar", "va, gracias"])("'%s' sigue cerrando", (text) => {
    expect(isClosingAcknowledgement(text, ASK_NAME)).toBe(true);
  });
});

describe("pregunta combinada de precio y 'qué incluye' con modismos", () => {
  it.each(["me dice cuanto sale y q incluye?", "¿Cuánto cuesta y qué incluye?", "precio y que incluye"])(
    "'%s' da precios y la abstención sin prometer información inexistente",
    (text) => {
      const answer = reply({ inbound: text, conversation: [{ role: "customer", text }] });
      expect(answer).not.toBeNull();
      expect(answer).toContain("Limpieza dental: $700 MXN");
      expect(answer).toMatch(/no detalla qu[eé] incluye/);
      expect(answer).not.toMatch(/m[aá]s informaci[oó]n sobre lo que incluye|le compartir[eé]|te compartir[eé]|le enviar[eé]/);
      expect(answer).toMatch(/\bsi lo desea\b/);
    }
  );

  it("en tono informal usa tú", () => {
    const answer = reply({
      inbound: "me dice cuanto sale y q incluye?",
      tone: "informal",
      conversation: [{ role: "customer", text: "me dice cuanto sale y q incluye?" }],
    });
    expect(answer).toMatch(/\bsi quieres\b/);
    expect(answer).not.toMatch(/\bsi lo desea\b/);
  });

  it("'q incluye cada una' también activa la abstención", () => {
    const answer = reply({
      inbound: "y q incluye cada una?",
      conversation: [{ role: "customer", text: "y q incluye cada una?" }],
    });
    expect(answer).toMatch(/no detalla qu[eé] incluye/);
  });

  it("si la KB sí detalla lo que incluye, no interviene la regla", () => {
    const answer = reply({
      inbound: "me dice cuanto sale y q incluye?",
      knowledge: `${KNOWLEDGE}\nLa limpieza incluye revisión y pulido.`,
      conversation: [{ role: "customer", text: "me dice cuanto sale y q incluye?" }],
    });
    expect(answer).toBeNull();
  });

  it("un 'qué incluye' sin pregunta de precio ni 'cada' sigue al modelo", () => {
    const answer = reply({
      inbound: "¿qué incluye la limpieza?",
      conversation: [{ role: "customer", text: "¿qué incluye la limpieza?" }],
    });
    expect(answer).toBeNull();
  });
});

describe("líneas de precio del documento — nunca una lista parcial", () => {
  // Las 10 líneas reales de "SERVICIOS Y PRECIOS DE REFERENCIA" del documento demo.
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
  const DEMO_KNOWLEDGE = [
    "2. SERVICIOS Y PRECIOS DE REFERENCIA",
    ...DEMO_PRICE_LINES,
    "Los precios son de referencia y pueden cambiar después de la valoración clínica.",
    "4. CITAS",
    "Para agendar una cita solicitar:",
    "- Nombre completo",
    "- Número de teléfono",
    "- Servicio o motivo de consulta",
  ].join("\n");
  const QUESTION = "me dice cuanto sale y q incluye?";

  it("con el documento demo la respuesta contiene las 10 líneas, incluida Ortodoncia", () => {
    const answer = reply({
      inbound: QUESTION,
      knowledge: DEMO_KNOWLEDGE,
      conversation: [{ role: "customer", text: QUESTION }],
    });
    expect(answer).not.toBeNull();
    for (const line of DEMO_PRICE_LINES) expect(answer).toContain(line);
    expect(answer).toContain("- Ortodoncia: valoración inicial $500 MXN");
  });

  it.each([
    "- Promoción especial $200 de descuento en limpieza",
    "- $1,200 MXN el paquete familiar",
  ])("una línea de lista con '$' que no se puede parsear (%s) deja la pregunta al modelo", (line) => {
    const answer = reply({
      inbound: QUESTION,
      knowledge: `${DEMO_KNOWLEDGE}\n${line}`,
      conversation: [{ role: "customer", text: QUESTION }],
    });
    expect(answer).toBeNull();
  });

  it("las líneas de precio fuera de una lista no bloquean la respuesta determinista", () => {
    const answer = reply({
      inbound: QUESTION,
      knowledge: `${DEMO_KNOWLEDGE}\nRespuesta: La limpieza dental tiene un precio de referencia de $700 MXN.`,
      conversation: [{ role: "customer", text: QUESTION }],
    });
    expect(answer).not.toBeNull();
    expect(answer).toContain("- Ortodoncia: valoración inicial $500 MXN");
  });
});

describe("evasivas tras la pregunta de nombre no cuentan como nombre", () => {
  function askedNameThen(text: string) {
    return reply({
      inbound: text,
      conversation: [
        { role: "customer", text: "Quiero avanzar hoy" },
        { role: "agent", text: ASK_NAME },
        { role: "customer", text },
      ],
    });
  }

  it.each(["Más tarde", "Lo pienso", "Estoy pensando", "Ahorita no", "Luego le digo", "Todavía nada"])(
    "'%s' no cuenta como nombre",
    (text) => {
      expect(askedNameThen(text)).toBeNull();
    }
  );

  it.each(["Juan Pérez", "María López"])("'%s' sí cuenta como nombre", (text) => {
    expect(askedNameThen(text)).toBe("Gracias. ¿Me comparte su número de teléfono?");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline real (runAgentTurn): el contexto llega a la regla determinista.
// ─────────────────────────────────────────────────────────────────────────────

const chatJson = vi.fn();

vi.mock("@/lib/ai", () => ({ chatJson: (...args: unknown[]) => chatJson(...args) }));
vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return { ...original, graphRequest: vi.fn() };
});
vi.mock("@/server/ai/observability", () => ({
  createAgentRun: async (input: { organizationId: string; conversationId: string }) => ({
    runId: "test-agent-run",
    organizationId: input.organizationId,
    conversationId: input.conversationId,
  }),
  finishAgentRun: async () => {},
  hasActiveAgentRun: () => true,
  recordAgentAction: async () => {},
  recordAgentEvidence: async () => {},
  withAgentRun: async <T>(_context: unknown, fn: () => Promise<T>): Promise<T> => fn(),
}));

const selectQueue: unknown[][] = [];
const inserts: { values: Record<string, unknown> }[] = [];

function thenableChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "where", "orderBy", "limit"]) chain[m] = () => chain;
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(rows).then(resolve);
  return chain;
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => thenableChain(selectQueue.shift() ?? []),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ values });
        const chain = {
          onConflictDoNothing: () => chain,
          onConflictDoUpdate: () => chain,
          returning: () => Promise.resolve([values]),
          then: (resolve: (v: unknown) => void) => Promise.resolve([values]).then(resolve),
        };
        return chain;
      },
    }),
    delete: () => ({ where: () => Promise.resolve([]) }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([{}]),
          then: (resolve: (v: unknown) => void) => Promise.resolve([{}]).then(resolve),
        }),
      }),
    }),
  }),
  schema: new Proxy(
    {},
    {
      get: (_t, tableName) =>
        new Proxy({}, { get: (_t2, col) => `${String(tableName)}.${String(col)}` }),
    }
  ),
}));

const CONVERSATION = {
  id: "cv_lab",
  organizationId: "org_1",
  contactId: "ct_lab",
  isTest: true,
  aiEnabled: true,
  handoffAt: null,
  handoffReason: null,
  lastInboundAt: new Date(),
};

const PROFILE = {
  id: "agp_1",
  organizationId: "org_1",
  enabled: true,
  name: "Asistente",
  tone: null,
  instructions: null,
  escalationRules: null,
  greeting: null,
};

function queueTurn(turns: Turn[]) {
  const base = Date.now() - 60_000;
  const history = turns.map((turn, index) => ({
    id: `m_${index}`,
    direction: turn.role === "customer" ? "in" : "out",
    type: "text",
    text: turn.text,
    createdAt: new Date(base + index * 1_000),
  }));
  // La consulta real ordena DESC y el pipeline la invierte.
  selectQueue.push(
    [CONVERSATION],
    [PROFILE],
    [...history].reverse(),
    [{ id: "kb_1", kind: "block", content: KNOWLEDGE, question: null, answer: null }],
    []
  );
}

function lastOutboundText(): string {
  const out = [...inserts]
    .reverse()
    .find((row) => (row.values as { direction?: string }).direction === "out");
  return (out?.values as { text?: string })?.text ?? "";
}

describe("pipeline — avance de compra sin repetir", () => {
  beforeEach(() => {
    selectQueue.length = 0;
    inserts.length = 0;
    chatJson.mockReset();
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("AGENDA", "off");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("el segundo 'quiero avanzar hoy' no repite el mensaje anterior del agente", async () => {
    queueTurn([
      { role: "customer", text: "Quiero avanzar hoy" },
      { role: "agent", text: ASK_NAME },
      { role: "customer", text: "Perfecto, quiero avanzar hoy" },
    ]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const text = lastOutboundText();
    expect(chatJson).not.toHaveBeenCalled();
    expect(text).not.toBe(ASK_NAME);
    expect(text).toMatch(/nombre completo/);
    expect(text).toMatch(/tel[eé]fono/);
    expect(text).toMatch(/servicio o motivo/);
  });

  it("'Juan Pérez' tras pedir el nombre lleva a pedir el teléfono", async () => {
    queueTurn([
      { role: "customer", text: "Quiero avanzar hoy" },
      { role: "agent", text: ASK_NAME },
      { role: "customer", text: "Juan Pérez" },
    ]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(chatJson).not.toHaveBeenCalled();
    expect(lastOutboundText()).toBe("Gracias. ¿Me comparte su número de teléfono?");
  });
});
