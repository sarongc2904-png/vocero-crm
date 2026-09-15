import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #agenda-fecha — El cliente pide un día concreto ("¿y el jueves?") y el
 * `offer_slots` que el modelo dispara viene con `day` (YYYY-MM-DD, calculado
 * por el modelo contra la fecha de "hoy" del prompt — ver prompts.ts).
 *
 * Bug reportado en vivo: el texto del modelo decía "Para el jueves..." pero
 * el motor siempre pegaba el catálogo general (los más próximos, que caían en
 * martes) porque `offer_slots` no tenía forma de pedir un día en concreto.
 *
 * Se mockea `computeAvailability` para devolver catálogos DISTINTOS según se
 * le pida el rango general o el día puntual — así el test detecta si
 * `offerSlots` de verdad consulta el día pedido, en vez de solo confiar en el
 * catálogo general.
 */

const DIA_PEDIDO = "2026-09-18"; // el "jueves" del ejemplo
const DIA_GENERAL = "2026-09-15"; // el "martes" que el catálogo general trae

const settings = {
  weeklyHours: {},
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 0,
  maxDaysAhead: 14,
  timezone: "UTC",
  connector: "google" as const,
  meetingLink: null,
};

const computeAvailability = vi.fn(
  async (_organizationId: string, opts?: { fromISO?: string; toISO?: string }) => {
    const esConsultaDeUnSoloDia =
      opts?.fromISO !== undefined && opts.fromISO === opts.toISO;

    if (esConsultaDeUnSoloDia) {
      // Igual que el motor real (acotado a `eachDateInRange(fromISO,toISO)`):
      // una consulta de un solo día JAMÁS devuelve slots de otro día.
      if (opts.fromISO === DIA_PEDIDO) {
        return [
          {
            startUtc: `${DIA_PEDIDO}T20:00:00.000Z`,
            endUtc: `${DIA_PEDIDO}T20:30:00.000Z`,
          },
        ];
      }
      return [];
    }

    // Catálogo general (sin acotar a un día): lo más próximo, que NO es el
    // día pedido.
    return [
      {
        startUtc: `${DIA_GENERAL}T08:00:00.000Z`,
        endUtc: `${DIA_GENERAL}T08:30:00.000Z`,
      },
      {
        startUtc: `${DIA_GENERAL}T08:15:00.000Z`,
        endUtc: `${DIA_GENERAL}T08:45:00.000Z`,
      },
      {
        startUtc: `${DIA_GENERAL}T08:30:00.000Z`,
        endUtc: `${DIA_GENERAL}T09:00:00.000Z`,
      },
    ];
  }
);

const replaceOffers = vi.fn(async () => {});

vi.mock("@/server/agenda/settings", () => ({ getSettings: async () => settings }));
vi.mock("@/server/agenda/availability", () => ({
  computeAvailability: (...args: unknown[]) =>
    computeAvailability(...(args as [string, object | undefined])),
}));
vi.mock("@/server/agenda/offers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/offers")>();
  return { ...original, replaceOffers: (...args: unknown[]) => replaceOffers(...(args as [])) };
});

describe("offerSlots con día pedido (#agenda-fecha)", () => {
  beforeEach(() => {
    computeAvailability.mockClear();
    replaceOffers.mockClear();
  });

  it("con día pedido y disponibilidad ese día: muestra ESE día, no el más próximo", async () => {
    const { offerSlots } = await import("@/server/agenda/agent");

    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      intro: "Para el jueves, tenemos los siguientes horarios disponibles:",
      day: DIA_PEDIDO,
    });

    expect(turn.ok).toBe(true);
    expect(turn.text).toContain("Para el jueves");
    expect(turn.text).toContain("20:00"); // el slot del día pedido
    expect(turn.text).not.toContain("08:00"); // NUNCA el catálogo general
    expect(turn.text).not.toContain("08:15");

    // Se consultó el día puntual, acotado — no solo el catálogo general.
    expect(computeAvailability).toHaveBeenCalledWith(
      "org_1",
      expect.objectContaining({ fromISO: DIA_PEDIDO, toISO: DIA_PEDIDO })
    );
  });

  it("con día pedido SIN disponibilidad: avisa y ofrece alternativas reales, sin fingir el día", async () => {
    const { offerSlots } = await import("@/server/agenda/agent");

    const diaSinCupo = "2026-09-20";
    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      intro: "Para el domingo, tenemos los siguientes horarios disponibles:",
      day: diaSinCupo,
    });

    expect(turn.ok).toBe(true);
    // NUNCA se usa el intro que prometía ese día: no hay nada que ofrecer ahí.
    expect(turn.text).not.toContain("Para el domingo");
    expect(turn.text).toContain("Ese día no tengo horarios disponibles");
    expect(turn.text).toContain("08:00"); // sí las alternativas reales
  });

  it("sin día pedido: se comporta como antes (el catálogo general, sin filtrar)", async () => {
    const { offerSlots } = await import("@/server/agenda/agent");

    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      intro: "Tengo estos horarios disponibles:",
    });

    expect(turn.ok).toBe(true);
    expect(turn.text).toContain("08:00");
    // No se hizo ninguna consulta acotada a un solo día.
    expect(computeAvailability).toHaveBeenCalledTimes(1);
  });
});
