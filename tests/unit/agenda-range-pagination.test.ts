import { describe, expect, it, vi } from "vitest";

/**
 * Fase 1 — segunda vuelta del bug de rangos: con `RANGE_TOTAL=24` y
 * `RANGE_PER_DAY=4`, un rango lunes→domingo (7 días) con ≥4 slots/día
 * consumía exactamente `6 × 4 = 24` y el domingo desaparecía SIN AVISO.
 *
 * `offerGrouped` (agent.ts) ahora garantiza al menos 1 slot por día ANTES de
 * repartir los adicionales, y siempre anuncia explícitamente lo que no
 * alcanzó a mostrarse — nunca un corte silencioso. Estos tests llaman
 * directamente a `offerRange`/`offerGeneralAvailability` (no todo el
 * pipeline) para poder inspeccionar la metadata de paginación exacta.
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

/** 7 días, lunes 21-sep a domingo 27-sep, `count` slots cada uno (15:00Z = 09:00 local, cada 45min). */
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

describe("offerGrouped — nunca un día completo desaparece sin aviso", () => {
  it("Test 1 — lunes→domingo, todos abiertos, 4 slots/día, RANGE_TOTAL=24: los 7 días quedan representados", async () => {
    computeAvailabilityImpl = async () => semanaCompleta(4); // 7×4 = 28 > 24: justo el caso que fallaba
    const { offerRange } = await import("@/server/agenda/agent");
    const turno = await offerRange({
      organizationId: "org_1",
      conversationId: "cv_1",
      startDate: "2026-09-21",
      endDate: "2026-09-27",
    });

    expect(turno.ok).toBe(true);
    expect(turno.pagination?.totalAvailableDays).toBe(7);
    expect(turno.pagination?.displayedDays).toBe(7); // RANGE_DAY_COVERAGE
    // Domingo, el que antes desaparecía, tiene que estar en el texto.
    expect(turno.text).toMatch(/domingo/i);
    expect(turno.text).toContain("27 de septiembre");
    // No caben los 28 completos en 24 de presupuesto: debe avisar que faltan.
    expect(turno.pagination?.truncated).toBe(true);
    expect(turno.pagination?.remainingSlots).toBeGreaterThan(0);
    expect(turno.text).toMatch(/más horarios/i); // RANGE_TRUNCATION_DISCLOSURE
  });

  it("Test 2 — presupuesto menor que el número de días con cupo: no trunca en silencio, remainingDays > 0 y se nombran los días", async () => {
    // 10 días con 1 slot cada uno, pero RANGE_TOTAL fijo en 24 en el código —
    // para forzar remainingDays>0 con un presupuesto ya ajustado, se simulan
    // más días de los que el tope permite representar ni con 1 slot cada uno
    // (24 días > presupuesto de 24... en realidad basta con más de 24 días).
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
    expect(turno.pagination?.displayedDays).toBeLessThan(30);
    expect(turno.pagination?.remainingDays).toBeGreaterThan(0); // nunca se trunca en silencio
    expect(turno.pagination?.truncated).toBe(true);
    // Los días omitidos se nombran explícitamente, no un "hay más" vago.
    expect(turno.text).toMatch(/también tengo disponibilidad/i);
  });

  it("Test 3 — rango con días sin disponibilidad: no se inventan, solo cuentan los días con slots reales", async () => {
    // Miércoles y viernes SIN disponibilidad — solo lunes/martes/jueves/domingo.
    computeAvailabilityImpl = async () => [
      { startUtc: "2026-09-21T15:00:00.000Z", endUtc: "2026-09-21T15:00:00.000Z" }, // lunes
      { startUtc: "2026-09-22T15:00:00.000Z", endUtc: "2026-09-22T15:00:00.000Z" }, // martes
      { startUtc: "2026-09-24T15:00:00.000Z", endUtc: "2026-09-24T15:00:00.000Z" }, // jueves
      { startUtc: "2026-09-27T15:00:00.000Z", endUtc: "2026-09-27T15:00:00.000Z" }, // domingo
    ];
    const { offerRange } = await import("@/server/agenda/agent");
    const turno = await offerRange({
      organizationId: "org_1",
      conversationId: "cv_1",
      startDate: "2026-09-21",
      endDate: "2026-09-27",
    });

    expect(turno.pagination?.totalAvailableDays).toBe(4); // no 7 — miércoles/viernes no cuentan
    expect(turno.pagination?.displayedDays).toBe(4);
    expect(turno.pagination?.truncated).toBe(false);
    expect(turno.text).not.toMatch(/miércoles|viernes/i);
  });

  it("Test 4 — todos los días representados pero sobran slots sueltos: remainingSlots > 0 y mensaje de continuación (no de días)", async () => {
    computeAvailabilityImpl = async () => [
      ...Array.from({ length: 8 }, (_, i) => ({
        startUtc: `2026-09-21T${String(15 + i).padStart(2, "0")}:00:00.000Z`,
        endUtc: `2026-09-21T${String(15 + i).padStart(2, "0")}:00:00.000Z`,
      })), // lunes con 8 slots — más de RANGE_PER_DAY(4)
      { startUtc: "2026-09-22T15:00:00.000Z", endUtc: "2026-09-22T15:00:00.000Z" }, // martes, 1 solo
    ];
    const { offerRange } = await import("@/server/agenda/agent");
    const turno = await offerRange({
      organizationId: "org_1",
      conversationId: "cv_1",
      startDate: "2026-09-21",
      endDate: "2026-09-22",
    });

    expect(turno.pagination?.totalAvailableDays).toBe(2);
    expect(turno.pagination?.displayedDays).toBe(2); // ambos días SÍ quedaron representados
    expect(turno.pagination?.remainingSlots).toBeGreaterThan(0); // pero sobran horarios del lunes
    expect(turno.pagination?.remainingDays).toBe(0);
    expect(turno.pagination?.truncated).toBe(true);
    expect(turno.text).toMatch(/tengo más horarios disponibles en algunos de estos días/i);
    expect(turno.text).not.toMatch(/también tengo disponibilidad/i); // ese mensaje es solo para días omitidos
  });
});
