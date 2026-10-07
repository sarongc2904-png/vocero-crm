import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * IA-1 — Cancelación SEGURA desde la conversación.
 *
 * Contrato anterior (bug): "Cancela mi cita" cancelaba de inmediato, y una
 * PREGUNTA como "¿Puedo cancelar mi cita?" también. Contrato nuevo:
 *   - imperativo → abre confirmación pendiente y NO cancela;
 *   - "sí" con pending vigente → cancela;
 *   - "sí" sin pending (o con pending expirado) → no cancela nada;
 *   - pregunta → informativa, sigue el flujo normal del modelo.
 */

const cancelBookingForConversation = vi.fn();
const chatJson = vi.fn();
const updates: Record<string, unknown>[] = [];
const inserts: Record<string, unknown>[] = [];
const selectQueue: unknown[][] = [];

vi.mock("@/lib/ai", () => ({ chatJson }));
vi.mock("@/server/agenda/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/service")>();
  return { ...original, cancelBookingForConversation };
});
vi.mock("@/server/ai/observability", () => ({
  createAgentRun: async (input: {
    organizationId: string;
    conversationId: string;
  }) => ({
    runId: "test-agent-run",
    organizationId: input.organizationId,
    conversationId: input.conversationId,
  }),
  finishAgentRun: async () => {},
  hasActiveAgentRun: () => true,
  recordAgentAction: async () => {},
  recordAgentEvidence: async () => {},
  withAgentRun: async <T>(
    _context: unknown,
    fn: () => Promise<T>
  ): Promise<T> => fn(),
}));

vi.mock("@/lib/db", () => {
  const chain = (rows: unknown[]) => {
    const value: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "where", "orderBy", "limit"]) {
      value[method] = () => value;
    }
    value.then = (resolve: (rows: unknown[]) => void) => Promise.resolve(rows).then(resolve);
    return value;
  };
  return {
    getDb: () => ({
      select: () => chain(selectQueue.shift() ?? []),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserts.push(values);
          const value: Record<string, unknown> = {};
          value.onConflictDoUpdate = () => Promise.resolve([]);
          value.onConflictDoNothing = () => value;
          value.returning = () => Promise.resolve([values]);
          value.then = (resolve: (rows: unknown[]) => void) =>
            Promise.resolve([values]).then(resolve);
          return value;
        },
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            updates.push(values);
            return Promise.resolve([]);
          },
        }),
      }),
      delete: () => ({ where: () => Object.assign(Promise.resolve([]), { returning: () => Promise.resolve(selectQueue.shift() ?? []) }) }),
    }),
    schema: new Proxy(
      {},
      { get: (_target, table) => new Proxy({}, { get: (_t, col) => `${String(table)}.${String(col)}` }) }
    ),
  };
});

const conversation = {
  id: "cv_1",
  organizationId: "org_1",
  contactId: "ct_1",
  isTest: true,
  aiEnabled: true,
  handoffAt: null,
  handoffReason: null,
  lastInboundAt: new Date(),
};
const profile = {
  id: "agp_1",
  organizationId: "org_1",
  enabled: true,
  name: "Agente",
  tone: null,
  instructions: null,
  escalationRules: null,
  greeting: null,
};

/** Cola de `select`: conversación, perfil, historial, pending (y lo que siga). */
function queueTurn(text: string, ...rest: unknown[][]) {
  selectQueue.push(
    [conversation],
    [profile],
    [{ id: "m_1", direction: "in", text, createdAt: new Date() }],
    ...rest
  );
}

function pendingRow(expiresInMs: number) {
  return [
    {
      id: "paa_1",
      action: "cancel",
      bookingId: "bk_1",
      startUtc: null,
      serviceId: null,
      professionalId: null,
      expiresAt: new Date(Date.now() + expiresInMs),
    },
  ];
}

function outboundText() {
  return [...inserts].reverse().find((row) => row.direction === "out")?.text;
}

describe("IA-1 — cancelación segura desde la conversación", () => {
  beforeEach(() => {
    selectQueue.length = 0;
    inserts.length = 0;
    updates.length = 0;
    cancelBookingForConversation.mockReset();
    chatJson.mockReset();
    vi.stubEnv("OPENROUTER_API_TOKEN", "test-token");
    vi.stubEnv("AGENDA", "on");
  });

  it("'Cancela mi cita' NO cancela: abre confirmación pendiente sin consultar al LLM", async () => {
    // Tras el turno: la conversación (contacto) y la cita activa que se nombra.
    queueTurn("Cancela mi cita", [{ contactId: "ct_1" }], [
      {
        id: "bk_1",
        scheduledAt: new Date(Date.now() + 3 * 86_400_000),
        timezone: "America/Mexico_City",
      },
    ]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1", "org_1");

    expect(cancelBookingForConversation).not.toHaveBeenCalled();
    expect(chatJson).not.toHaveBeenCalled();
    // El perfil no define tono: se trata de usted.
    expect(outboundText()).toContain("Antes de cancelar necesito su confirmación");
    expect(inserts.some((row) => row.action === "cancel")).toBe(true);
    expect(updates).not.toContainEqual(
      expect.objectContaining({ handoffAt: expect.anything() })
    );
  });

  it("con un perfil que tutea, la pregunta pide 'tu confirmación'", async () => {
    selectQueue.push(
      [conversation],
      [{ ...profile, tone: "Cercano e informal, tutea al cliente" }],
      [{ id: "m_1", direction: "in", text: "Cancela mi cita", createdAt: new Date() }],
      [{ contactId: "ct_1" }],
      [
        {
          id: "bk_1",
          scheduledAt: new Date(Date.now() + 3 * 86_400_000),
          timezone: "America/Mexico_City",
        },
      ]
    );

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1", "org_1");

    expect(cancelBookingForConversation).not.toHaveBeenCalled();
    expect(outboundText()).toContain("Antes de cancelar necesito tu confirmación");
    expect(outboundText()).toContain("¿confirmas que quieres cancelar tu cita");
    expect(outboundText()).toContain("Responde «sí»");
  });

  it("'sí' con pending vigente cancela y confirma", async () => {
    cancelBookingForConversation.mockResolvedValueOnce({
      bookingId: "bk_1",
      label: "domingo, 20 de septiembre a las 10:20",
    });
    queueTurn("sí", pendingRow(60_000));

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1", "org_1");

    // Se cancela ESA cita (la de la pendiente), no "la próxima".
    expect(cancelBookingForConversation).toHaveBeenCalledWith({
      organizationId: "org_1",
      conversationId: "cv_1",
      bookingId: "bk_1",
    });
    // El éxito sigue nombrando fecha y hora de la cita cancelada.
    expect(outboundText()).toBe(
      "Listo, cancelé su cita: domingo, 20 de septiembre a las 10:20."
    );
    expect(chatJson).not.toHaveBeenCalled();
  });

  it("'sí' SIN pending no cancela nada", async () => {
    chatJson.mockResolvedValueOnce({ ok: true, data: { action: "none" } });
    queueTurn("sí", [], [], []);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1", "org_1");

    expect(cancelBookingForConversation).not.toHaveBeenCalled();
  });

  it("'sí' con pending EXPIRADO no cancela", async () => {
    chatJson.mockResolvedValueOnce({ ok: true, data: { action: "none" } });
    queueTurn("sí", pendingRow(-60_000), [], []);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1", "org_1");

    expect(cancelBookingForConversation).not.toHaveBeenCalled();
  });

  it("una PREGUNTA informativa no cancela y sigue el flujo normal", async () => {
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { reply: "...", action: "reply", text: "Puedes cancelar avisando con 24 h." },
    });
    queueTurn("¿Puedo cancelar mi cita?", [], []);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1", "org_1");

    expect(cancelBookingForConversation).not.toHaveBeenCalled();
    expect(chatJson).toHaveBeenCalled();
  });

  it("sin cita activa, la confirmación responde sin handoff", async () => {
    const { BookingError } = await import("@/server/agenda/service");
    cancelBookingForConversation.mockRejectedValueOnce(
      new BookingError("not_found", "No hay una cita activa")
    );
    queueTurn("sí", pendingRow(60_000));

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1", "org_1");

    expect(outboundText()).toBe("No encontré una cita activa para cancelar.");
    expect(updates).not.toContainEqual(
      expect.objectContaining({ handoffAt: expect.anything() })
    );
  });
});
