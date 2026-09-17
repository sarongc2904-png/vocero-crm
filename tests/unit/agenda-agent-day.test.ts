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

const DIA_PEDIDO = "2026-09-18";
const DIA_GENERAL = "2026-09-15";

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
    expect(turn.text).toContain("20:00");
    expect(turn.text).not.toContain("08:00");
    expect(turn.text).not.toContain("08:15");

    expect(replaceOffers).toHaveBeenCalledTimes(1);
    const llamada = replaceOffers.mock.calls[0] as unknown as [
      string,
      string,
      { startUtc: string }[],
    ];
    const ofertasRegistradas = llamada[2];
    expect(ofertasRegistradas).toHaveLength(1);
    expect(ofertasRegistradas[0]!.startUtc).toBe(`${DIA_PEDIDO}T20:00:00.000Z`);

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
    expect(turn.text).not.toContain("Para el domingo");
    expect(turn.text).toContain("Ese día no tengo horarios disponibles");
    expect(turn.text).toContain("08:00");
  });

  it("sin día pedido: agrupa por día y conserva todos los horarios", async () => {
    const { offerSlots } = await import("@/server/agenda/agent");

    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      intro: "Tengo estos horarios disponibles:",
    });

    expect(turn.ok).toBe(true);
    expect(turn.text).toContain("08:00");
    expect(turn.text).toContain("08:15");
    expect(turn.text).toContain("08:30");
    expect(turn.text.match(/^• /gm)).toHaveLength(3);
    expect(turn.text).not.toContain("a las 08:00");
    expect(computeAvailability).toHaveBeenCalledTimes(1);
  });

  it("descarta horarios inventados por el modelo dentro del intro", async () => {
    const { offerSlots } = await import("@/server/agenda/agent");

    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      intro:
        "Estos son los horarios disponibles:\n• hoy a las 10:20\n• hoy a las 11:00\n• hoy a las 11:40",
    });

    expect(turn.ok).toBe(true);
    expect(turn.text).toMatch(/^Tengo estos horarios disponibles:/);
    expect(turn.text).not.toContain("10:20");
    expect(turn.text).not.toContain("11:00");
    expect(turn.text).not.toContain("11:40");
    expect(turn.text).toContain("08:00");
    expect(turn.text).toContain("08:15");
    expect(turn.text).toContain("08:30");
  });
});
