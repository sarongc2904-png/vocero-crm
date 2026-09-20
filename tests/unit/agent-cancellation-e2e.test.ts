import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/lib/db", () => {
  const chain = (rows: unknown[]) => {
    const value: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy", "limit"]) {
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
          return Promise.resolve([values]);
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

function queueTurn(text: string) {
  selectQueue.push(
    [conversation],
    [profile],
    [{ id: "m_1", direction: "in", text, createdAt: new Date() }]
  );
}

function outboundText() {
  return [...inserts].reverse().find((row) => row.direction === "out")?.text;
}

describe("cancelación automática desde conversación", () => {
  beforeEach(() => {
    selectQueue.length = 0;
    inserts.length = 0;
    updates.length = 0;
    cancelBookingForConversation.mockReset();
    chatJson.mockReset();
    vi.stubEnv("OPENROUTER_API_TOKEN", "test-token");
    vi.stubEnv("AGENDA", "on");
  });

  it("'Cancela mi cita' cancela y confirma sin consultar al LLM ni hacer handoff", async () => {
    cancelBookingForConversation.mockResolvedValueOnce({
      bookingId: "bk_1",
      label: "domingo, 20 de septiembre a las 10:20",
    });
    queueTurn("Cancela mi cita");

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1", "org_1");

    expect(cancelBookingForConversation).toHaveBeenCalledWith({
      organizationId: "org_1",
      conversationId: "cv_1",
    });
    expect(outboundText()).toBe(
      "Listo, cancelé tu cita: domingo, 20 de septiembre a las 10:20."
    );
    expect(chatJson).not.toHaveBeenCalled();
    expect(updates).not.toContainEqual(expect.objectContaining({ handoffAt: expect.anything() }));
  });

  it("sin cita activa responde sin handoff", async () => {
    const { BookingError } = await import("@/server/agenda/service");
    const { runAgentTurn } = await import("@/server/ai/pipeline");
    cancelBookingForConversation.mockRejectedValueOnce(
      new BookingError("not_found", "No hay una cita activa")
    );
    queueTurn("Cancela mi cita");

    await runAgentTurn("cv_1", "org_1");

    expect(outboundText()).toBe("No encontré una cita activa para cancelar.");
    expect(chatJson).not.toHaveBeenCalled();
    expect(updates).not.toContainEqual(expect.objectContaining({ handoffAt: expect.anything() }));
  });
});
