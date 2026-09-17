import { describe, expect, it, vi } from "vitest";

/**
 * Contrato actual: la disponibilidad que devuelve computeAvailability se
 * muestra completa. Ya no existe presupuesto artificial de 24 slots ni tope
 * por día; la metadata de paginación debe reflejar que no quedó nada oculto.
 */

const settings = {
  weeklyHours: {},
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 0,
  maxDaysAhead: 14,
  timezone: "America/Mexico_City",
  connector: "google" as const,
  meetingLink: null,
};

vi.mock("@/server/agenda/settings", () => ({ getSettings: async () => settings }));

const replaceOffers = vi.fn(async () => {});
vi.mock("@/server/agenda/offers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/offers")>();
  return { ...original, replaceOffers };
});

let computeAvailabilityImpl: (org: string, opts?: { fromISO?: string; toISO?: string }) => Promise<
  { startUtc: string; endUtc: string }[]
> = async () => [];

vi.mock("@/server/agenda/availability", () => ({
  computeAvailability: (org: string, opts?: { fromISO?: string; toISO?: string }) =>
    computeAvailabilityImpl(org, opts),
}));

function semanaCompleta(countPorDia: number) {
  const dias = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"];
  const out: { startUtc: string; endUtc: string }[] = [];
  for (const dia of dias) {
    for (let i = 0; i < countPorDia; i++) {
      const minutos = i * 45;
      const h = String(15 + Math.floor(minutos / 60)).padStart(2, "0");
      const m = String(minutos % 60).padStart(2, "0");
      out.push({ startUtc: `${dia}T${h}:${m}:00.000Z`, endUtc: `${dia}T${h}:${m}:00.000Z` });
    }
  }
  return out;
}

describe("offerGrouped — disponibilidad completa", () => {
  it("muestra los 28 slots de lunes a domingo sin truncar", async () => {
    computeAvailabilityImpl = async () => semanaCompleta(4);
    const { offerRange } = await import("@/server/agenda/agent");
    const turno = await offerRange({
      organizationId: "org_1",
      conversationId: "cv_1",
      startDate: "2026-09-21",
      endDate: "2026-09-27",
    });

    expect(turno.ok).toBe(true);
    expect(turno.pagination).toEqual({
      totalAvailableSlots: 28,
      displayedSlots: 28,
      totalAvailableDays: 7,
      displayedDays: 7,
      remainingSlots: 0,
      remainingDays: 0,
      truncated: false,
    });
    expect(turno.text).toMatch(/domingo/i);
    expect(turno.text).toContain("27 de septiembre");
    expect(replaceOffers).toHaveBeenLastCalledWith(
      "org_1",
      "cv_1",
      expect.arrayContaining([expect.objectContaining({ startUtc: "2026-09-27T17:15:00.000Z" })])
    );
  });

  it("muestra todos los días disponibles aunque sean más de 24", async () => {
    const dias = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 8, 21 + i));
      return d.toISOString().slice(0, 10);
    });
    computeAvailabilityImpl = async () =>
      dias.map((dia) => ({ startUtc: `${dia}T15:00:00.000Z`, endUtc: `${dia}T15:00:00.000Z` }));

    const { offerRange } = await import("@/server/agenda/agent");
    const turno = await offerRange({
      organizationId: "org_1",
      conversationId: "cv_1",
      startDate: dias[0]!,
      endDate: dias[dias.length - 1]!,
    });

    expect(turno.pagination?.totalAvailableDays).toBe(30);
    expect(turno.pagination?.displayedDays).toBe(30);
    expect(turno.pagination?.remainingDays).toBe(0);
    expect(turno.pagination?.remainingSlots).toBe(0);
    expect(turno.pagination?.truncated).toBe(false);
  });

  it("no inventa días sin disponibilidad", async () => {
    computeAvailabilityImpl = async () => [
      { startUtc: "2026-09-21T15:00:00.000Z", endUtc: "2026-09-21T15:00:00.000Z" },
      { startUtc: "2026-09-22T15:00:00.000Z", endUtc: "2026-09-22T15:00:00.000Z" },
      { startUtc: "2026-09-24T15:00:00.000Z", endUtc: "2026-09-24T15:00:00.000Z" },
      { startUtc: "2026-09-27T15:00:00.000Z", endUtc: "2026-09-27T15:00:00.000Z" },
    ];
    const { offerRange } = await import("@/server/agenda/agent");
    const turno = await offerRange({
      organizationId: "org_1",
      conversationId: "cv_1",
      startDate: "2026-09-21",
      endDate: "2026-09-27",
    });

    expect(turno.pagination?.totalAvailableDays).toBe(4);
    expect(turno.pagination?.displayedDays).toBe(4);
    expect(turno.pagination?.truncated).toBe(false);
    expect(turno.text).not.toMatch(/miércoles|viernes/i);
  });

  it("muestra todos los slots de un día sin tope por día", async () => {
    computeAvailabilityImpl = async () => [
      ...Array.from({ length: 8 }, (_, i) => ({
        startUtc: `2026-09-21T${String(15 + i).padStart(2, "0")}:00:00.000Z`,
        endUtc: `2026-09-21T${String(15 + i).padStart(2, "0")}:00:00.000Z`,
      })),
      { startUtc: "2026-09-22T15:00:00.000Z", endUtc: "2026-09-22T15:00:00.000Z" },
    ];
    const { offerRange } = await import("@/server/agenda/agent");
    const turno = await offerRange({
      organizationId: "org_1",
      conversationId: "cv_1",
      startDate: "2026-09-21",
      endDate: "2026-09-22",
    });

    expect(turno.pagination).toEqual({
      totalAvailableSlots: 9,
      displayedSlots: 9,
      totalAvailableDays: 2,
      displayedDays: 2,
      remainingSlots: 0,
      remainingDays: 0,
      truncated: false,
    });
    expect(turno.text).toContain("16:00");
    expect(turno.text).toContain("22:00");
  });
});
