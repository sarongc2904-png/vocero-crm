import { beforeEach, describe, expect, it, vi } from "vitest";

const cancelBookingAutomations = vi.fn(async () => {});
const deleteMeeting = vi.fn(async () => {});
const bindConnector = vi.fn(async () => ({
  deleteMeeting,
  updateMeeting: vi.fn(),
  createMeeting: vi.fn(),
  testConnection: vi.fn(),
}));
const selectQueue: unknown[][] = [];
const updateSets: Record<string, unknown>[] = [];

vi.mock("@/server/agenda/settings", () => ({
  getSettings: async () => ({
    timezone: "America/Mexico_City",
    connector: "google",
  }),
}));
vi.mock("@/server/agenda/connectors", () => ({
  bindConnector,
  markConnectorAuthError: vi.fn(),
}));
vi.mock("@/server/automations/queue", () => ({
  cancelBookingAutomations,
  scheduleBookingAutomations: vi.fn(),
  scheduleReviewRequests: vi.fn(),
}));
vi.mock("@/server/events/bus", () => ({ publish: vi.fn() }));
vi.mock("@/lib/db", () => {
  const chain = (rows: unknown[]) => {
    const value: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy"]) value[method] = () => value;
    value.limit = () => Promise.resolve(rows);
    return value;
  };
  return {
    getDb: () => ({
      select: () => chain(selectQueue.shift() ?? []),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            updateSets.push(values);
            return Promise.resolve([]);
          },
        }),
      }),
      insert: () => ({ values: () => Promise.resolve([]) }),
    }),
    schema: new Proxy(
      {},
      { get: (_target, table) => new Proxy({}, { get: (_t, col) => `${String(table)}.${String(col)}` }) }
    ),
  };
});

const ACTIVE = {
  id: "bk_a",
  organizationId: "org_a",
  conversationId: "cv_a",
  contactId: "ct_a",
  kind: "session",
  status: "agendada",
  scheduledAt: new Date("2026-09-20T16:20:00.000Z"),
  durationMinutes: 30,
  timezone: "America/Mexico_City",
  connector: "google",
  externalRef: "google_event_1",
  isTest: false,
};

describe("cancelBookingForConversation", () => {
  beforeEach(() => {
    selectQueue.length = 0;
    updateSets.length = 0;
    cancelBookingAutomations.mockClear();
    deleteMeeting.mockClear();
    bindConnector.mockClear();
  });

  it("cancela CRM, recordatorios y evento externo de la próxima cita", async () => {
    selectQueue.push([{ contactId: "ct_a" }], [ACTIVE], [ACTIVE]);
    const { cancelBookingForConversation } = await import("@/server/agenda/service");

    const result = await cancelBookingForConversation({
      organizationId: "org_a",
      conversationId: "cv_a",
      now: new Date("2026-09-19T12:00:00.000Z"),
    });

    expect(result.bookingId).toBe("bk_a");
    expect(updateSets).toContainEqual(expect.objectContaining({ status: "cancelada" }));
    expect(cancelBookingAutomations).toHaveBeenCalledWith("org_a", "bk_a");
    expect(deleteMeeting).toHaveBeenCalledWith("google_event_1");
  });

  it("una segunda cancelación directa es idempotente", async () => {
    selectQueue.push([{ ...ACTIVE, status: "cancelada" }]);
    const { cancelBooking } = await import("@/server/agenda/service");

    await cancelBooking({ organizationId: "org_a", bookingId: "bk_a" });

    expect(updateSets).toHaveLength(0);
    expect(cancelBookingAutomations).not.toHaveBeenCalled();
    expect(deleteMeeting).not.toHaveBeenCalled();
  });

  it("tenant A no puede resolver ni cancelar una conversación de tenant B", async () => {
    selectQueue.push([]);
    const { cancelBookingForConversation } = await import("@/server/agenda/service");

    await expect(
      cancelBookingForConversation({
        organizationId: "org_a",
        conversationId: "cv_b",
      })
    ).rejects.toMatchObject({ code: "not_found" });
    expect(updateSets).toHaveLength(0);
    expect(cancelBookingAutomations).not.toHaveBeenCalled();
    expect(deleteMeeting).not.toHaveBeenCalled();
  });
});
