import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfferedSlot } from "@/server/agenda/offers";

/**
 * Oferta de horarios repartida en mañana y tarde.
 *
 * Caso real (negocio "prueba", L-V 09:00-18:00, citas de 30 min, aviso 2 h,
 * America/Mexico_City): ante "Por la tarde" se ofrecían siempre los cuatro
 * primeros huecos desde las 12:00 (12:00, 12:30, 13:00, 13:30) aunque la
 * agenda llegara hasta las 18:00.
 *
 * Reglas:
 *  - Sin preferencia: mañana (< 12:00) y tarde (>= 12:00) en el mismo mensaje.
 *    Con 6 huecos o menos en el día se listan todos; con más, 2-3 por bloque
 *    REPARTIDOS a lo largo del bloque, bajo "Mañana:" y "Tarde:", invitando a
 *    pedir otra hora. Un bloque vacío no se muestra.
 *  - "por la mañana" / "por la tarde": solo ese bloque, repartido, del día
 *    que se está mostrando.
 *  - "más tarde": horarios POSTERIORES a los ya mostrados ese mismo día.
 */

const TZ = "America/Mexico_City";
const TUE = "2026-10-06";
const WED = "2026-10-07";
// 2026-10-05 22:43 en Ciudad de México (UTC-6).
const NOW = new Date("2026-10-06T04:43:00.000Z");

const settings = {
  weeklyHours: {
    mon: [{ start: "09:00", end: "18:00" }],
    tue: [{ start: "09:00", end: "18:00" }],
    wed: [{ start: "09:00", end: "18:00" }],
    thu: [{ start: "09:00", end: "18:00" }],
    fri: [{ start: "09:00", end: "18:00" }],
  },
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 2,
  maxDaysAhead: 14,
  timezone: TZ,
  connector: "google" as const,
  meetingLink: null,
};

/** "16:00" del día local → instante UTC (CDMX es UTC-6 todo el año). */
function at(day: string, time: string): string {
  return new Date(`${day}T${time}:00-06:00`).toISOString();
}

function minutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h! * 60 + m!;
}

/** Huecos de 30 min de 09:00 a 17:30, menos los ocupados. */
function freeDay(day: string, taken: string[] = []) {
  const out: { startUtc: string; endUtc: string; label: string }[] = [];
  for (let m = 9 * 60; m < 18 * 60; m += 30) {
    const time = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    if (taken.includes(time)) continue;
    out.push({
      startUtc: at(day, time),
      endUtc: new Date(Date.parse(at(day, time)) + 30 * 60_000).toISOString(),
      label: `${day} ${time}`,
    });
  }
  return out;
}

function timesIn(text: string): string[] {
  return [...text.matchAll(/^• (\d{2}:\d{2})$/gm)].map((m) => m[1]!);
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

function availability(days: Record<string, ReturnType<typeof freeDay>>) {
  mocks.computeAvailability.mockImplementation(
    async (_org: string, opts?: { fromISO?: string; toISO?: string }) => {
      const all = Object.values(days).flat();
      if (opts?.fromISO && opts.fromISO === opts.toISO) return days[opts.fromISO] ?? [];
      return all;
    }
  );
}

describe("oferta sin preferencia: mañana y tarde en el mismo mensaje", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.replaceOffers.mockClear();
    mocks.computeAvailability.mockReset();
  });

  it("día completo (18 huecos): 2-3 de la mañana y 2-3 de la tarde, repartidos", async () => {
    availability({ [TUE]: freeDay(TUE), [WED]: freeDay(WED) });
    const { offerSlots } = await import("@/server/agenda/agent");
    const turn = await offerSlots({ organizationId: "org_1", conversationId: "cv_1" });

    expect(turn.ok).toBe(true);
    expect(turn.text).toContain("Mañana:");
    expect(turn.text).toContain("Tarde:");
    const times = timesIn(turn.text);
    const morning = times.filter((t) => minutes(t) < 12 * 60);
    const afternoon = times.filter((t) => minutes(t) >= 12 * 60);
    expect(morning.length).toBeGreaterThanOrEqual(2);
    expect(morning.length).toBeLessThanOrEqual(3);
    expect(afternoon.length).toBeGreaterThanOrEqual(2);
    expect(afternoon.length).toBeLessThanOrEqual(3);
    // Repartidos: la tarde llega hasta el último hueco del día.
    expect(afternoon).toContain("17:30");
    expect(morning).toContain("09:00");
    // Invita a pedir otra hora porque no se listó todo.
    expect(turn.text).toMatch(/otra hora/i);
    // Solo el primer día disponible.
    expect(turn.text).not.toContain("7 de octubre");
    // Todo el catálogo sigue persistido para poder reservar cualquier hueco.
    expect(mocks.replaceOffers.mock.calls[0]![2]).toHaveLength(36);
  });

  it("6 huecos o menos en el día: se listan todos", async () => {
    const few = freeDay(TUE).filter((s) =>
      ["09:00", "11:30", "12:00", "15:00", "16:00", "17:30"].some((t) => s.startUtc === at(TUE, t))
    );
    availability({ [TUE]: few, [WED]: freeDay(WED) });
    const { offerSlots } = await import("@/server/agenda/agent");
    const turn = await offerSlots({ organizationId: "org_1", conversationId: "cv_1" });

    expect(timesIn(turn.text)).toEqual(["09:00", "11:30", "12:00", "15:00", "16:00", "17:30"]);
  });

  it("si ya no hay mañana, muestra solo la tarde", async () => {
    const afternoonOnly = freeDay(TUE).filter((s) => Date.parse(s.startUtc) >= Date.parse(at(TUE, "12:00")));
    availability({ [TUE]: afternoonOnly, [WED]: freeDay(WED) });
    const { offerSlots } = await import("@/server/agenda/agent");
    const turn = await offerSlots({ organizationId: "org_1", conversationId: "cv_1" });

    expect(turn.text).not.toContain("Mañana:");
    expect(turn.text).toContain("Tarde:");
    const times = timesIn(turn.text);
    expect(times.every((t) => minutes(t) >= 12 * 60)).toBe(true);
    expect(times).toContain("17:30");
  });

  it("un día pedido también se reparte en mañana y tarde", async () => {
    availability({ [TUE]: freeDay(TUE), [WED]: freeDay(WED) });
    const { offerSlots } = await import("@/server/agenda/agent");
    const turn = await offerSlots({ organizationId: "org_1", conversationId: "cv_1", day: WED });

    expect(turn.text).toContain("7 de octubre");
    expect(turn.text).toContain("Mañana:");
    expect(turn.text).toContain("Tarde:");
    expect(timesIn(turn.text)).toContain("17:30");
  });
});

describe("preferencia explícita de bloque", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.replaceOffers.mockClear();
    mocks.computeAvailability.mockReset();
  });

  it("'por la tarde' reparte la tarde del día mostrado, no los cuatro primeros", async () => {
    availability({ [TUE]: freeDay(TUE), [WED]: freeDay(WED) });
    const { offerSlots } = await import("@/server/agenda/agent");
    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      expand: "afternoon",
      cursor: 0,
      referenceDay: TUE,
    } as Parameters<typeof offerSlots>[0]);

    const times = timesIn(turn.text);
    expect(times.length).toBeGreaterThanOrEqual(2);
    expect(times.every((t) => minutes(t) >= 12 * 60)).toBe(true);
    expect(times).not.toEqual(["12:00", "12:30", "13:00", "13:30"]);
    expect(times).toContain("17:30");
    expect(turn.text).toContain("6 de octubre");
    expect(turn.text).not.toContain("7 de octubre");
  });

  it("'por la mañana' reparte la mañana del día mostrado", async () => {
    availability({ [TUE]: freeDay(TUE), [WED]: freeDay(WED) });
    const { offerSlots } = await import("@/server/agenda/agent");
    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      expand: "morning",
      cursor: 0,
      referenceDay: TUE,
    } as Parameters<typeof offerSlots>[0]);

    const times = timesIn(turn.text);
    expect(times.every((t) => minutes(t) < 12 * 60)).toBe(true);
    expect(times).toContain("09:00");
    expect(times).toContain("11:30");
  });

  it("'por la tarde' cuando el día mostrado ya no tiene tarde: lo dice y pasa al siguiente", async () => {
    const morningOnly = freeDay(TUE).filter((s) => Date.parse(s.startUtc) < Date.parse(at(TUE, "12:00")));
    availability({ [TUE]: morningOnly, [WED]: freeDay(WED) });
    const { offerSlots } = await import("@/server/agenda/agent");
    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      expand: "afternoon",
      cursor: 0,
      referenceDay: TUE,
    } as Parameters<typeof offerSlots>[0]);

    expect(turn.text).toMatch(/ya no hay horarios por la tarde/i);
    expect(turn.text).toContain("7 de octubre");
    expect(timesIn(turn.text).every((t) => minutes(t) >= 12 * 60)).toBe(true);
  });

  it("'más tarde' muestra horarios posteriores a los ya mostrados ese día", async () => {
    availability({ [TUE]: freeDay(TUE), [WED]: freeDay(WED) });
    const { offerSlots } = await import("@/server/agenda/agent");
    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      expand: "later",
      cursor: 0,
      referenceDay: TUE,
      afterTime: "13:30",
    } as unknown as Parameters<typeof offerSlots>[0]);

    const times = timesIn(turn.text);
    expect(times.length).toBeGreaterThan(0);
    expect(times.every((t) => minutes(t) > minutes("13:30"))).toBe(true);
    expect(turn.text).toContain("6 de octubre");
    expect(turn.text).not.toContain("7 de octubre");
  });

  it("'más tarde' sin huecos posteriores ese día: lo dice y pasa al siguiente", async () => {
    availability({ [TUE]: freeDay(TUE), [WED]: freeDay(WED) });
    const { offerSlots } = await import("@/server/agenda/agent");
    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      expand: "later",
      cursor: 0,
      referenceDay: TUE,
      afterTime: "17:30",
    } as unknown as Parameters<typeof offerSlots>[0]);

    expect(turn.text).toMatch(/ya no hay horarios más tarde/i);
    expect(turn.text).toContain("7 de octubre");
  });
});

/**
 * Barrido: días con 1..18 huecos libres en patrones variados. Cada iteración
 * verifica que lo mostrado existe, está ordenado y respeta el bloque; las dos
 * ramas (listar todo / repartir) deben ejercitarse al menos una vez.
 */
describe("barrido de presentación por día", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.replaceOffers.mockClear();
    mocks.computeAvailability.mockReset();
  });

  it("nunca muestra un hueco inexistente; reparte cuando hay más de 6", async () => {
    const { offerSlots } = await import("@/server/agenda/agent");
    const branches = { all: 0, spread: 0 };
    const all = freeDay(TUE);
    for (let size = 1; size <= all.length; size += 1) {
      for (const offset of [0, 3, 7]) {
        const subset = all.filter((_, i) => (i + offset) % all.length < size);
        availability({ [TUE]: subset, [WED]: freeDay(WED) });
        const turn = await offerSlots({ organizationId: "org_1", conversationId: "cv_1" });
        const shown = timesIn(turn.text);
        const free = subset.map((s) => new Date(s.startUtc).toISOString());
        for (const t of shown) expect(free, `size=${size} offset=${offset} t=${t}`).toContain(at(TUE, t));
        expect([...shown].sort(), `orden size=${size}`).toEqual(shown);
        if (subset.length <= 6) {
          branches.all += 1;
          expect(shown.length, `size=${size}`).toBe(subset.length);
        } else {
          branches.spread += 1;
          const morning = subset.filter((s) => Date.parse(s.startUtc) < Date.parse(at(TUE, "12:00")));
          const afternoon = subset.filter((s) => Date.parse(s.startUtc) >= Date.parse(at(TUE, "12:00")));
          const shownMorning = shown.filter((t) => minutes(t) < 12 * 60);
          const shownAfternoon = shown.filter((t) => minutes(t) >= 12 * 60);
          expect(shownMorning.length).toBe(Math.min(3, morning.length));
          expect(shownAfternoon.length).toBe(Math.min(3, afternoon.length));
          // Repartido: incluye el último hueco de cada bloque con más de uno.
          if (afternoon.length > 1) {
            expect(shownAfternoon.at(-1), `size=${size} offset=${offset}`).toBe(
              new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(
                new Date(afternoon.at(-1)!.startUtc)
              )
            );
          }
          expect(turn.text).toMatch(/otra hora/i);
        }
      }
    }
    expect(branches.all).toBeGreaterThan(0);
    expect(branches.spread).toBeGreaterThan(0);
  });
});
