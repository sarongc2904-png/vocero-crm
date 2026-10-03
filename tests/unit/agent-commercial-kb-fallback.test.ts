import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  rankDocumentChunks,
  type DocumentRetrievalCandidate,
} from "@/server/kb/documents/retrieval";
import {
  acceptsAdvisorOffer,
  isBriefAffirmative,
  offeredAdvisor,
  rejectedHandoffFallback,
  shouldAllowModelHandoff,
} from "@/server/ai/handoff";

/**
 * Lab 2026-10-03 (Judge v6): "Preguntón de precios" y "Comprador decidido"
 * recibían "Claro, puedo ayudarte con eso. Dime qué información necesitas."
 * ante preguntas concretas de precio aunque el documento del negocio tenía la
 * lista de precios. Cadena reproducida aquí:
 *
 *  1. Retrieval léxico exacto sobre SOLO el último mensaje: "cuesta/opción" no
 *     coincide con "PRECIOS/SERVICIOS", así que el catálogo nunca llegaba, y
 *     los follow-ups ("¿Qué incluye cada una?") recuperaban 0 fragmentos.
 *  2. Sí llegaba el fragmento con "ESCALAMIENTO A UNA PERSONA … cuando el
 *     agente no tenga una respuesta confirmada / solicite un descuento": el
 *     modelo pedía handoff, el backend lo rechazaba (sin regla configurada) y,
 *     tras un reintento igual, el pipeline sustituía la respuesta por la frase
 *     genérica fija.
 */

const GENERIC = "Claro, puedo ayudarte con eso. Dime qué información necesitas.";

// Fragmentos con la misma estructura que el documento real del Lab.
const CATALOG = [
  "CLÍNICA DENTAL SONRISA PLUS",
  "1. INFORMACIÓN GENERAL",
  "Clínica Dental Sonrisa Plus ofrece atención dental para adultos y niños.",
  "2. SERVICIOS Y PRECIOS DE REFERENCIA",
  "- Consulta de valoración: $300 MXN",
  "- Limpieza dental: $700 MXN",
  "- Resina dental: desde $800 MXN por pieza",
  "- Blanqueamiento dental: desde $2,500 MXN",
  "- Brackets metálicos: desde $8,000 MXN",
  "Los precios son de referencia y pueden cambiar después de la valoración clínica.",
  "3. HORARIOS",
  "Lunes a viernes: 9:00 a.m. a 7:00 p.m.",
  "4. CITAS",
  "Para agendar una cita solicitar:",
  "- Nombre completo",
  "- Número de teléfono",
  "- Servicio o motivo de consulta",
  "- Día y horario preferido",
].join("\n");

const POLICIES = [
  "5. POLÍTICAS DE CITAS",
  "- Las citas pueden reprogramarse con al menos 4 horas de anticipación.",
  "- El agente no debe prometer descuentos ni promociones no registradas.",
  "7. REGLAS IMPORTANTES",
  "- No inventar precios, horarios, promociones o disponibilidad.",
].join("\n");

const ESCALATION_AND_FAQ = [
  "8. ESCALAMIENTO A UNA PERSONA",
  "Pasar la conversación a un asesor humano cuando:",
  "- El paciente pida hablar con una persona.",
  "- Solicite un descuento o negociación especial.",
  "- El agente no tenga una respuesta confirmada.",
  "9. PREGUNTAS FRECUENTES",
  "Pregunta: ¿Necesito cita?",
  "Respuesta: Sí, recomendamos agendar para asegurar disponibilidad.",
  "Pregunta: ¿Cuánto cuesta una limpieza?",
  "Respuesta: La limpieza dental tiene un precio de referencia de $700 MXN.",
  "Pregunta: ¿Cuánto cuestan los brackets?",
  "Respuesta: Los brackets metálicos tienen un precio de referencia desde $8,000 MXN.",
].join("\n");

const LOCATION = [
  "10. UBICACIÓN",
  "Av. Reforma 1234, Col. Centro, Nuevo Laredo, Tamaulipas.",
].join("\n");

function chunk(id: string, content: string, position: number): DocumentRetrievalCandidate {
  return {
    id,
    organizationId: "org_1",
    documentId: "doc_sonrisa",
    documentStatus: "ready",
    approved: true,
    content,
    position,
    page: null,
  };
}

const CHUNKS = [
  chunk("catalog", CATALOG, 0),
  chunk("policies", POLICIES, 1),
  chunk("escalation_faq", ESCALATION_AND_FAQ, 2),
  chunk("location", LOCATION, 3),
];

function retrievedIds(query: string, contextQuery?: string): string[] {
  return rankDocumentChunks(CHUNKS, {
    organizationId: "org_1",
    query,
    contextQuery,
    maxChunks: 5,
    maxCharacters: 7_500,
  }).map((row) => row.id);
}

describe("retrieval comercial — el catálogo llega para preguntas concretas", () => {
  // TEST A
  it("¿Cuánto cuesta cada opción? recupera el catálogo con precios", () => {
    expect(retrievedIds("¿Cuánto cuesta cada opción?")).toContain("catalog");
  });

  // TEST B
  it("¿Qué incluye cada una? usa el contexto previo de la conversación", () => {
    const context = "Hola, ¿qué opciones manejan?\n¿Cuánto cuesta cada opción?";
    expect(retrievedIds("¿Qué incluye cada una?", context)).toContain("catalog");
  });

  it("el contexto previo no desplaza a lo que coincide con el turno actual", () => {
    const ids = retrievedIds("¿Cuál es su ubicación?", "¿Cuánto cuesta la limpieza?");
    expect(ids[0]).toBe("location");
  });

  // TEST C
  it("¿Tienen algún descuento o condición especial? recupera la política de descuentos", () => {
    expect(
      retrievedIds("¿Tienen algún descuento o condición especial?")
    ).toContain("policies");
  });

  // TEST D
  it("¿Cuánto cuesta y qué necesito para empezar? trae precios y requisitos de cita", () => {
    expect(retrievedIds("¿Cuánto cuesta y qué necesito para empezar?")).toContain(
      "catalog"
    );
  });

  // TEST E
  it("contraste: 'me dice cuanto sale y q incluye?' sigue recuperando precios (ahora también el catálogo)", () => {
    const ids = retrievedIds("me dice cuanto sale y q incluye?");
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("catalog");
    const contents = CHUNKS.filter((row) => ids.includes(row.id))
      .map((row) => row.content)
      .join("\n");
    expect(contents).toContain("$700 MXN");
  });

  // TEST F
  it.each([
    "¿Cuánto cuesta?",
    "¿Cuánto sale la limpieza?",
    "¿Cuánto cobran?",
    "¿Qué precio tiene?",
    "¿Qué costo tiene la limpieza?",
    "¿Cuáles son sus tarifas?",
    "¿Me pasa una cotización?",
    "¿Cuánto cuestan sus servicios?",
    "Quiero saber los precios",
  ])("paráfrasis de precio '%s' recupera el catálogo", (query) => {
    expect(retrievedIds(query)).toContain("catalog");
  });

  it.each(["¿Qué incluye la limpieza?", "¿Qué necesito para empezar?"])(
    "paráfrasis '%s' recupera conocimiento relevante",
    (query) => {
      expect(retrievedIds(query).length).toBeGreaterThan(0);
    }
  );

  it("un saludo sin contexto no recupera nada", () => {
    expect(retrievedIds("Hola")).toEqual([]);
  });

  it("'vale' o 'sale' sueltos no se interpretan como precio", () => {
    expect(retrievedIds("Va, vale")).toEqual([]);
    expect(retrievedIds("¿A qué hora sale?")).not.toContain("catalog");
  });
});

describe("acentos y signos de apertura no cambian el resultado (hipótesis descartada)", () => {
  it.each([
    ["¿Cuánto cuesta cada opción?", "cuanto cuesta cada opcion?"],
    ["¿Qué incluye cada una?", "que incluye cada una"],
    ["¿Tienen algún descuento o condición especial?", "tienen algun descuento o condicion especial"],
    ["¡Hola! ¿Qué opciones manejan?", "hola que opciones manejan"],
  ])("'%s' recupera lo mismo que '%s' (también en NFD)", (accented, plain) => {
    const context = "¿Cuánto cuesta cada opción?";
    expect(retrievedIds(accented, context)).toEqual(retrievedIds(plain, context));
    expect(retrievedIds(accented.normalize("NFD"), context)).toEqual(
      retrievedIds(plain, context)
    );
    expect(rejectedHandoffFallback(accented)).toBe(rejectedHandoffFallback(plain));
  });

  it("con acentos, '¿Cuánto cuesta cada opción?' recupera > 0 fragmentos con precio", () => {
    const rows = rankDocumentChunks(CHUNKS, {
      organizationId: "org_1",
      query: "¿Cuánto cuesta cada opción?",
      maxChunks: 5,
      maxCharacters: 7_500,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.content).join("\n")).toContain("Limpieza dental: $700 MXN");
  });
});

describe("punto de decisión — el backend no autoriza handoff para preguntas comerciales", () => {
  it.each([
    "Hola, ¿qué opciones manejan?",
    "¿Cuánto cuesta cada opción?",
    "¿Qué incluye cada una?",
    "¿Tienen algún descuento o condición especial?",
    "¿Cuánto cuesta y qué necesito para empezar?",
  ])("'%s' sin reglas de escalado → handoff del modelo no autorizado", (text) => {
    // Es la condición que, antes de esta corrección, terminaba en la frase fija.
    expect(shouldAllowModelHandoff(text, null)).toBe(false);
  });
});

describe("aceptación de una oferta explícita de asesor", () => {
  const FALLBACK_OFFER = rejectedHandoffFallback("¿Tienen algún descuento?");

  it("el fallback ofrece el asesor como pregunta, sin exigir una frase exacta", () => {
    expect(FALLBACK_OFFER).toContain("¿Quiere que un asesor se lo confirme?");
    expect(FALLBACK_OFFER).not.toMatch(/escr[ií]b/);
    expect(offeredAdvisor(FALLBACK_OFFER)).toBe(true);
  });

  it.each([
    "¿Le gustaría que un asesor se lo confirme?",
    "No tengo ese dato confirmado. Si lo desea, puedo pasarle con un asesor.",
    "¿Quieres que te comunique con alguien del equipo?",
  ])("reconoce la oferta: %s", (text) => {
    expect(offeredAdvisor(text)).toBe(true);
  });

  it.each([
    "Un asesor le atenderá en recepción. ¿Algo más en lo que pueda ayudarle?",
    "La limpieza cuesta $700 MXN. ¿Le gustaría agendar una cita?",
    null,
  ])("no confunde una mención o pregunta distinta con una oferta: %s", (text) => {
    expect(offeredAdvisor(text)).toBe(false);
  });

  it.each(["sí", "Sí, por favor", "ok", "dale", "Claro", "de acuerdo", "sí gracias 👍"])(
    "'%s' es una aceptación breve",
    (text) => {
      expect(isBriefAffirmative(text)).toBe(true);
    }
  );

  it.each([
    "no gracias",
    "No, gracias",
    "sí, ¿cuánto cuesta la limpieza?",
    "sí pero primero quiero saber los horarios de la tarde",
    "",
  ])("'%s' no es una aceptación breve", (text) => {
    expect(isBriefAffirmative(text)).toBe(false);
  });

  it("oferta + 'sí' autoriza; 'sí' sin oferta y oferta + 'no gracias' no", () => {
    expect(acceptsAdvisorOffer("sí", FALLBACK_OFFER)).toBe(true);
    expect(shouldAllowModelHandoff("sí", null, FALLBACK_OFFER)).toBe(true);
    expect(acceptsAdvisorOffer("sí", "La limpieza cuesta $700 MXN.")).toBe(false);
    expect(shouldAllowModelHandoff("sí", null, null)).toBe(false);
    expect(shouldAllowModelHandoff("sí", null)).toBe(false);
    expect(acceptsAdvisorOffer("no gracias", FALLBACK_OFFER)).toBe(false);
    expect(shouldAllowModelHandoff("no gracias", null, FALLBACK_OFFER)).toBe(false);
  });
});

describe("fallback tras handoff rechazado — nunca genérico ante una pregunta concreta", () => {
  it.each([
    "¿Cuánto cuesta cada opción?",
    "¿Qué incluye cada una?",
    "¿Tienen algún descuento o condición especial?",
    "¿Cuánto cuesta y qué necesito para empezar?",
    "Quiero contratar hoy",
  ])("'%s' no recibe la frase genérica", (text) => {
    const reply = rejectedHandoffFallback(text);
    expect(reply).not.toBe(GENERIC);
    expect(reply).not.toMatch(/dime qu[eé] informaci[oó]n necesitas/i);
    expect(reply).toMatch(/confirmad/i);
    expect(reply).toMatch(/asesor/i);
  });

  it("un saludo sin petición concreta recibe una invitación breve", () => {
    const reply = rejectedHandoffFallback("Hola");
    expect(reply).not.toBe(GENERIC);
    expect(reply).not.toMatch(/confirmad/i);
  });

  it("conserva la respuesta empática ante una queja", () => {
    expect(
      rejectedHandoffFallback("Estoy molesto porque tuve un problema y necesito una solución.")
    ).toBe(
      "Entiendo que tuvo un problema y quiero ayudarle a resolverlo. ¿Puede contarme qué ocurrió?"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline real (runAgentTurn) con DB y proveedor simulados.
// ─────────────────────────────────────────────────────────────────────────────

const chatJson = vi.fn();
const recordAgentAction = vi.fn(async (_input: unknown) => {});
const recordAgentEvidence = vi.fn(
  async (_items: Array<{ sourceType: string; snapshot: Record<string, unknown> }>) => {}
);

function recordedDocumentChunks(): string[] {
  return recordAgentEvidence.mock.calls
    .flatMap(([items]) => items)
    .filter((item) => item.sourceType === "document_chunk")
    .map((item) => String(item.snapshot.content));
}

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
  recordAgentAction: (input: unknown) => recordAgentAction(input),
  recordAgentEvidence: (items: Array<{ sourceType: string; snapshot: Record<string, unknown> }>) =>
    recordAgentEvidence(items),
  withAgentRun: async <T>(_context: unknown, fn: () => Promise<T>): Promise<T> => fn(),
}));

const selectQueue: unknown[][] = [];
const inserts: { table: unknown; values: Record<string, unknown> }[] = [];
const updates: Record<string, unknown>[] = [];

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
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
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
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return {
          where: () => ({
            returning: () => Promise.resolve([{}]),
            then: (resolve: (v: unknown) => void) => Promise.resolve([{}]).then(resolve),
          }),
        };
      },
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

// Perfil real del Lab: sin reglas de escalado y con la instrucción libre que
// empuja a "un asesor" cuando el modelo no se siente seguro.
const PROFILE = {
  id: "agp_1",
  organizationId: "org_1",
  enabled: true,
  name: "Asistente Conecta Digital",
  tone: null,
  instructions:
    "Responde de forma clara, breve y útil. No inventes información, precios ni condiciones. Si no tienes una respuesta segura, indica que un asesor humano puede continuar la atención.",
  escalationRules: null,
  greeting: null,
};

function queueTurn(customerTexts: string[], lastAgentText = "Respuesta previa del agente.") {
  const base = Date.now() - 60_000;
  const history = customerTexts.flatMap((text, index) => {
    const rows: Record<string, unknown>[] = [
      { id: `in_${index}`, direction: "in", type: "text", text, createdAt: new Date(base + index * 2_000) },
    ];
    if (index < customerTexts.length - 1) {
      rows.push({
        id: `out_${index}`,
        direction: "out",
        type: "text",
        text: index === customerTexts.length - 2 ? lastAgentText : "Respuesta previa del agente.",
        createdAt: new Date(base + index * 2_000 + 1_000),
      });
    }
    return rows;
  });
  // La consulta real ordena por createdAt DESC y el pipeline la invierte.
  selectQueue.push([CONVERSATION], [PROFILE], [...history].reverse(), [], [], CHUNKS);
}

function lastOutboundText(): string {
  const out = [...inserts]
    .reverse()
    .find((row) => (row.values as { direction?: string }).direction === "out");
  return (out?.values as { text?: string })?.text ?? "";
}

function modelMessages(call: number): string {
  const messages = chatJson.mock.calls[call]?.[1] as { content: string }[] | undefined;
  return (messages ?? []).map((message) => message.content).join("\n\n");
}

describe("pipeline — pregunta concreta con handoff no autorizado", () => {
  beforeEach(() => {
    selectQueue.length = 0;
    inserts.length = 0;
    updates.length = 0;
    chatJson.mockReset();
    recordAgentAction.mockClear();
    recordAgentEvidence.mockClear();
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("AGENDA", "off");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("el modelo recibe el catálogo de precios para '¿Cuánto cuesta cada opción?'", async () => {
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { action: "reply", text: "Limpieza $700 MXN y brackets desde $8,000 MXN." },
    });
    queueTurn(["Hola, ¿qué opciones manejan?", "¿Cuánto cuesta cada opción?"]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    // Cadena completa: chunks recuperados > 0 → precio en la entrada del
    // modelo → precio en la respuesta entregada.
    const chunks = recordedDocumentChunks();
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("\n")).toContain("Limpieza dental: $700 MXN");
    expect(modelMessages(0)).toContain("Brackets metálicos: desde $8,000 MXN");
    expect(lastOutboundText()).toContain("$700");
    expect(lastOutboundText()).not.toBe(GENERIC);
  });

  it("'¿Qué incluye cada una?' llega al modelo con el catálogo gracias al contexto", async () => {
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { action: "reply", text: "¿Sobre qué servicio quiere el detalle?" },
    });
    queueTurn([
      "Hola, ¿qué opciones manejan?",
      "¿Cuánto cuesta cada opción?",
      "¿Qué incluye cada una?",
    ]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(recordedDocumentChunks().length).toBeGreaterThan(0);
    expect(modelMessages(0)).toContain("2. SERVICIOS Y PRECIOS DE REFERENCIA");
  });

  it("el reintento usa un contrato que excluye handoff", async () => {
    chatJson
      .mockResolvedValueOnce({ ok: true, data: { action: "handoff", reason: "Sin respuesta confirmada" } })
      .mockResolvedValueOnce({ ok: true, data: { action: "reply", text: "La limpieza cuesta $700 MXN." } });
    queueTurn(["¿Cuánto cuesta cada opción?"]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const firstSchema = chatJson.mock.calls[0]![0] as { safeParse: (v: unknown) => { success: boolean } };
    const retrySchema = chatJson.mock.calls[1]![0] as { safeParse: (v: unknown) => { success: boolean } };
    const handoff = { action: "handoff", reason: "x" };
    expect(firstSchema.safeParse(handoff).success).toBe(true);
    expect(retrySchema.safeParse(handoff).success).toBe(false);
    expect(retrySchema.safeParse({ action: "reply", text: "ok" }).success).toBe(true);
  });

  it("si el reintento no produce una acción válida, el fallback nombra la pregunta y respeta usted", async () => {
    chatJson
      .mockResolvedValueOnce({
        ok: true,
        data: { action: "handoff", reason: "Solicita descuento", farewell: "Le paso con un asesor." },
      })
      // El proveedor devuelve algo fuera del contrato sin handoff.
      .mockResolvedValueOnce({ ok: false, error: "invalid_output", detail: "handoff no permitido" });
    queueTurn(["¿Tienen algún descuento o condición especial?"]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(chatJson).toHaveBeenCalledTimes(2);
    // La política de descuentos llega al modelo en ambos intentos.
    expect(recordedDocumentChunks().join("\n")).toContain(
      "El agente no debe prometer descuentos"
    );
    const retryGuidance = modelMessages(1);
    expect(retryGuidance).toMatch(/documentos/i);
    expect(retryGuidance).toMatch(/no autorizan/i);

    const reply = lastOutboundText();
    expect(reply).not.toBe(GENERIC);
    expect(reply).toContain("descuentos o promociones");
    expect(reply).toMatch(/confirmad/i);
    expect(reply).toContain("compartirle");
    expect(reply).not.toMatch(/\bdime\b|ayudarte/i);
    // No se pausó la conversación: el handoff no estaba autorizado.
    expect(updates.some((values) => values.handoffAt instanceof Date)).toBe(false);
    // El rechazo queda trazado con su motivo.
    expect(recordAgentAction).toHaveBeenCalledWith({
      action: "handoff",
      success: false,
      status: "rejected",
      payload: { reason: "Solicita descuento", recovery: "fallback" },
    });
  });

  it("si el reintento responde, se usa su respuesta concreta", async () => {
    chatJson
      .mockResolvedValueOnce({
        ok: true,
        data: { action: "handoff", reason: "No tengo respuesta confirmada" },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          action: "reply",
          text: "La limpieza cuesta $700 MXN. Para empezar agendamos una valoración; ¿qué día le conviene?",
        },
      });
    queueTurn(["¿Cuánto cuesta y qué necesito para empezar?"]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const chunks = recordedDocumentChunks().join("\n");
    expect(chunks).toContain("Limpieza dental: $700 MXN");
    expect(chunks).toContain("Para agendar una cita solicitar:");
    expect(lastOutboundText()).toContain("$700 MXN");
    expect(recordAgentAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "handoff", status: "rejected" })
    );
  });

  const OFFER =
    "Sobre descuentos o promociones, por ahora no tengo información confirmada para compartirle por este medio. ¿Quiere que un asesor se lo confirme?";

  function handedOff(): boolean {
    return updates.some(
      (values) => values.handoffAt instanceof Date && values.handoffReason === "cliente"
    );
  }

  it("oferta de asesor + 'sí' → handoff determinista", async () => {
    queueTurn(["¿Tienen algún descuento o condición especial?", "sí"], OFFER);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(chatJson).not.toHaveBeenCalled();
    expect(handedOff()).toBe(true);
  });

  it("'sí' sin oferta previa de asesor → no hay handoff aunque el modelo lo pida", async () => {
    chatJson
      .mockResolvedValueOnce({ ok: true, data: { action: "handoff", reason: "El cliente aceptó" } })
      .mockResolvedValueOnce({ ok: true, data: { action: "reply", text: "Perfecto. ¿Qué día le conviene?" } });
    queueTurn(
      ["¿Cuánto cuesta la limpieza?", "sí"],
      "La limpieza cuesta $700 MXN. ¿Le gustaría agendar una valoración?"
    );

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(handedOff()).toBe(false);
    expect(updates.some((values) => values.handoffAt instanceof Date)).toBe(false);
    expect(recordAgentAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "handoff", status: "rejected" })
    );
    expect(lastOutboundText()).toBe("Perfecto. ¿Qué día le conviene?");
  });

  it("oferta de asesor + 'no gracias' → no hay handoff", async () => {
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { action: "reply", text: "Entendido. ¿Le ayudo con algo más?" },
    });
    queueTurn(["¿Tienen algún descuento o condición especial?", "no gracias"], OFFER);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(handedOff()).toBe(false);
    expect(updates.some((values) => values.handoffAt instanceof Date)).toBe(false);
    expect(lastOutboundText()).toBe("Entendido. ¿Le ayudo con algo más?");
  });

  it("oferta de asesor + 'sí': si el turno llega al modelo, su handoff está autorizado", () => {
    expect(shouldAllowModelHandoff("Sí, por favor", null, OFFER)).toBe(true);
  });

  it("una petición explícita de persona sigue haciendo handoff (sin pasar por el modelo)", async () => {
    queueTurn(["Quiero hablar con un asesor"]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(chatJson).not.toHaveBeenCalled();
    expect(
      updates.some(
        (values) => values.handoffAt instanceof Date && values.handoffReason === "cliente"
      )
    ).toBe(true);
    expect(recordAgentAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "handoff", status: "rejected" })
    );
  });
});
