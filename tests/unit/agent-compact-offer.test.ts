import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfferedSlot } from "@/server/agenda/offers";

/**
 * UX compacta de disponibilidad (issue: "Horario" volcaba 5–7 días).
 *
 * La herramienta conserva TODA la disponibilidad internamente (se persiste
 * para reservar); lo que se limita es SOLO lo que se presenta al cliente:
 * sin fecha → 1 día y ≤4 horarios; un día concreto → ese día y ≤5; el día
 * pedido lleno → el día siguiente con ≤4. Ampliar solo ante petición
 * explícita. Nunca se inventa un slot y el timezone del tenant se respeta.
 */

const DAY1 = "2026-09-16";
const DAY2 = "2026-09-17";
const DAY_SIN_CUPO = "2026-09-20";

let settings: {
  weeklyHours: Record<string, { start: string; end: string }[]>;
  slotMinutes: number;
  bufferMinutes: number;
  minNoticeHours: number;
  maxDaysAhead: number;
  timezone: string;
  connector: "google";
  meetingLink: string | null;
};

function resetSettings(timezone = "UTC") {
  settings = {
    weeklyHours: {},
    slotMinutes: 30,
    bufferMinutes: 0,
    minNoticeHours: 0,
    maxDaysAhead: 14,
    timezone,
    connector: "google",
    meetingLink: null,
  };
}

function daySlots(dayIso: string, hours: number[]) {
  return hours.map((h) => ({
    startUtc: `${dayIso}T${String(h).padStart(2, "0")}:00:00.000Z`,
    endUtc: `${dayIso}T${String(h).padStart(2, "0")}:30:00.000Z`,
  }));
}

const mocks = vi.hoisted(() => ({
  computeAvailability: vi.fn(),
  replaceOffers: vi.fn(
    async (_organizationId: string, _conversationId: string, _slots: OfferedSlot[]) => {}
  ),
}));

vi.mock("@/server/agenda/settings", () => ({ getSettings: async () => settings }));
vi.mock("@/server/agenda/availability", () => ({
  computeAvailability: mocks.computeAvailability,
}));
vi.mock("@/server/agenda/offers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/offers")>();
  return { ...original, replaceOffers: mocks.replaceOffers };
});

describe("presentación compacta de disponibilidad", () => {
  beforeEach(() => {
    resetSettings();
    mocks.replaceOffers.mockClear();
    mocks.computeAvailability.mockReset();
  });

  it("sin fecha → SOLO el primer día disponible, en mañana y tarde, máximo 6 horarios", async () => {
    mocks.computeAvailability.mockImplementation(async (_org: string, opts?: { fromISO?: string; toISO?: string }) => {
      if (opts?.fromISO && opts.fromISO === opts.toISO) return [];
      return [...daySlots(DAY1, [9, 10, 11, 12, 13, 14]), ...daySlots(DAY2, [9, 10, 11])];
    });

    const { offerSlots } = await import("@/server/agenda/agent");
    const turn = await offerSlots({ organizationId: "org_1", conversationId: "cv_1" });

    expect(turn.ok).toBe(true);
    const visible = turn.text.match(/^• /gm) ?? [];
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThanOrEqual(6);
    expect(turn.text).toContain("Mañana:");
    expect(turn.text).toContain("Tarde:");
    expect(turn.text).toContain("09:00");
    expect(turn.text).toContain("12:00");
    // El segundo día (17 de septiembre) NO se vuelca.
    expect(turn.text).not.toContain("17 de septiembre");
    expect(turn.text).toContain("¿Cuál te funciona mejor?");

    // Todo el catálogo (6 + 3 = 9 slots) queda persistido internamente.
    const persisted = mocks.replaceOffers.mock.calls[0]![2];
    expect(persisted).toHaveLength(9);
  });

  it("día específico → SOLO ese día y máximo 6 horarios", async () => {
    mocks.computeAvailability.mockImplementation(async (_org: string, opts?: { fromISO?: string; toISO?: string }) => {
      if (opts?.fromISO && opts.fromISO === opts.toISO) {
        return opts.fromISO === DAY2 ? daySlots(DAY2, [9, 10, 11, 12, 13, 14]) : [];
      }
      return [...daySlots(DAY1, [9, 10, 11]), ...daySlots(DAY2, [9, 10, 11, 12, 13, 14])];
    });

    const { offerSlots } = await import("@/server/agenda/agent");
    const turn = await offerSlots({ organizationId: "org_1", conversationId: "cv_1", day: DAY2 });

    expect(turn.ok).toBe(true);
    const visible = turn.text.match(/^• /gm) ?? [];
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThanOrEqual(6);
    expect(turn.text).toContain("17 de septiembre");
    expect(turn.text).not.toContain("16 de septiembre"); // el día anterior NO aparece
  });

  it("día pedido sin cupo → ofrece el día siguiente con máximo 6", async () => {
    mocks.computeAvailability.mockImplementation(async (_org: string, opts?: { fromISO?: string; toISO?: string }) => {
      if (opts?.fromISO && opts.fromISO === opts.toISO) return []; // el día pedido está lleno
      return [...daySlots(DAY1, [9, 10, 11, 12, 13])];
    });

    const { offerSlots } = await import("@/server/agenda/agent");
    const turn = await offerSlots({ organizationId: "org_1", conversationId: "cv_1", day: DAY_SIN_CUPO });

    expect(turn.ok).toBe(true);
    expect(turn.text).toContain("no tengo horarios disponibles");
    const visible = turn.text.match(/^• /gm) ?? [];
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThanOrEqual(6); // tope del día siguiente
    expect(turn.text).toContain("09:00");
    expect(turn.text).toContain("16 de septiembre"); // solo el día siguiente disponible
    expect(turn.text).not.toContain("20 de septiembre"); // el día pedido no se lista
  });

  it("ampliación 'otro día' → muestra el SEGUNDO día disponible", async () => {
    mocks.computeAvailability.mockImplementation(async () => [
      ...daySlots(DAY1, [9, 10, 11]),
      ...daySlots(DAY2, [12, 13, 14, 15]),
    ]);

    const { offerSlots } = await import("@/server/agenda/agent");
    const turn = await offerSlots({ organizationId: "org_1", conversationId: "cv_1", expand: "next_day" });

    expect(turn.ok).toBe(true);
    expect(turn.text).toContain("Otro día tengo:");
    expect(turn.text).toContain("17 de septiembre");
    expect(turn.text).not.toContain("16 de septiembre");
    expect(turn.text.match(/^• /gm)).toHaveLength(4);
  });

  it("ampliación 'más tarde'/'por la tarde' → muestra horarios de la tarde", async () => {
    mocks.computeAvailability.mockImplementation(async () => [
      ...daySlots(DAY1, [9, 10, 11]),
      ...daySlots(DAY1, [13, 14, 15, 16, 17]),
      ...daySlots(DAY2, [18, 19]),
    ]);

    const { offerSlots } = await import("@/server/agenda/agent");
    const turn = await offerSlots({ organizationId: "org_1", conversationId: "cv_1", expand: "afternoon" });

    expect(turn.ok).toBe(true);
    expect(turn.text).toContain("Para la tarde tengo:");
    expect(turn.text).toContain("13:00");
    expect(turn.text).toContain("16:00");
    expect(turn.text).not.toContain("09:00"); // mañana no se muestra
    const visible = turn.text.match(/^• /gm) ?? [];
    expect(visible.length).toBeLessThanOrEqual(6); // tope del bloque
    expect(turn.text).not.toContain("17 de septiembre"); // no salta de día
  });

  it("ampliación 'fin de semana' → muestra solo sábado/domingo", async () => {
    const SAT = "2026-09-19";
    const SUN = "2026-09-20";
    mocks.computeAvailability.mockImplementation(async () => [
      ...daySlots(DAY1, [9, 10]),
      ...daySlots(SAT, [11, 12, 13, 14, 15]),
      ...daySlots(SUN, [9, 10]),
    ]);

    const { offerSlots } = await import("@/server/agenda/agent");
    const turn = await offerSlots({ organizationId: "org_1", conversationId: "cv_1", expand: "weekend" });

    expect(turn.ok).toBe(true);
    expect(turn.text).toContain("En fin de semana tengo:");
    expect(turn.text).toContain("19 de septiembre");
    expect(turn.text).not.toContain("16 de septiembre"); // día de semana descartado
    expect(turn.text).not.toContain("20 de septiembre"); // un solo día por oferta
    const visible = turn.text.match(/^• /gm) ?? [];
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThanOrEqual(6);
  });

  it("nunca inventa un slot: el intro con horarios falsos se descarta y solo salen los reales", async () => {
    mocks.computeAvailability.mockImplementation(async () => [...daySlots(DAY1, [9, 10, 11, 12])]);

    const { offerSlots } = await import("@/server/agenda/agent");
    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      intro: "Estos son los horarios disponibles:\n• 10:20\n• 11:40\n• 13:20",
    });

    expect(turn.ok).toBe(true);
    expect(turn.text).toMatch(/^Tengo estos horarios disponibles:/);
    expect(turn.text).not.toContain("10:20");
    expect(turn.text).not.toContain("11:40");
    expect(turn.text).not.toContain("13:20");
    expect(turn.text).toContain("09:00"); // real
    expect(turn.text).toContain("12:00"); // real
  });

  it("respeta el timezone del tenant (15:00Z se muestra como 09:00 en Mexico_City)", async () => {
    resetSettings("America/Mexico_City");
    mocks.computeAvailability.mockImplementation(async () => [
      { startUtc: "2026-09-16T15:00:00.000Z", endUtc: "2026-09-16T15:30:00.000Z" },
      { startUtc: "2026-09-16T15:40:00.000Z", endUtc: "2026-09-16T16:10:00.000Z" },
    ]);

    const { offerSlots } = await import("@/server/agenda/agent");
    const turn = await offerSlots({ organizationId: "org_1", conversationId: "cv_1" });

    expect(turn.text).toContain("09:00");
    expect(turn.text).toContain("09:40");
    expect(turn.text).not.toContain("15:00");
  });
});
