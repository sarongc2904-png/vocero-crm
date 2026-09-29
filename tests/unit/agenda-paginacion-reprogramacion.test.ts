import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OfferedSlot } from "@/server/agenda/offers";

/**
 * IA-3 — "otros horarios" avanza de verdad (A → B → C → D, sin repetir).
 * QB-06 — la reprogramación manual deriva la disponibilidad DE LA CITA.
 */

const h = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  upserts: [] as Record<string, unknown>[],
  deletes: 0,
}));

function thenableChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit", "orderBy"]) chain[m] = () => chain;
  (chain as { then: unknown }).then = (res: (v: unknown) => void) =>
    Promise.resolve(rows).then(res);
  return chain;
}

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...original,
    getDb: () => ({
      select: () => thenableChain(h.selectQueue.shift() ?? []),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          const chain: Record<string, unknown> = {};
          chain.onConflictDoUpdate = (args: { set: Record<string, unknown> }) => {
            h.upserts.push({ ...values, ...args.set });
            return Promise.resolve([]);
          };
          chain.then = (res: (v: unknown) => void) =>
            Promise.resolve([values]).then(res);
          return chain;
        },
      }),
      delete: () => ({
        where: () => {
          h.deletes += 1;
          return Promise.resolve([]);
        },
      }),
    }),
  };
});

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

const mocks = vi.hoisted(() => ({
  computeAvailability: vi.fn(),
  replaceOffers: vi.fn(
    async (_o: string, _c: string, _s: OfferedSlot[]) => {}
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

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

function days(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const day = `2026-09-${String(16 + i).padStart(2, "0")}`;
    return [
      { startUtc: `${day}T09:00:00.000Z`, endUtc: `${day}T09:30:00.000Z` },
      { startUtc: `${day}T15:00:00.000Z`, endUtc: `${day}T15:30:00.000Z` },
    ];
  }).flat();
}

beforeEach(() => {
  h.selectQueue.length = 0;
  h.upserts.length = 0;
  h.deletes = 0;
  mocks.replaceOffers.mockClear();
});

describe("IA-3 — el cursor de expansión avanza la ventana", () => {
  it("next_day con cursor 0 → 1 → 2 devuelve días DISTINTOS", async () => {
    mocks.computeAvailability.mockResolvedValue(days(5));
    const { offerSlots } = await import("@/server/agenda/agent");

    const first = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      expand: "next_day",
      cursor: 0,
    });
    const second = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      expand: "next_day",
      cursor: 1,
    });
    const third = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      expand: "next_day",
      cursor: 2,
    });

    expect(first.text).toContain("17 de septiembre");
    expect(second.text).toContain("18 de septiembre");
    expect(third.text).toContain("19 de septiembre");
    // Nunca repite la ventana anterior.
    expect(second.text).not.toContain("17 de septiembre");
    expect(third.text).not.toContain("18 de septiembre");
  });

  it("agotadas las ventanas dice claramente que no hay más (no reinicia)", async () => {
    mocks.computeAvailability.mockResolvedValue(days(2));
    const { offerSlots } = await import("@/server/agenda/agent");

    const exhausted = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      expand: "next_day",
      cursor: 5,
    });

    expect(exhausted.ok).toBe(false);
    expect(exhausted.text).toContain("No me quedan más días disponibles");
  });

  it("'más tarde' y 'fin de semana' también avanzan por su propio criterio", async () => {
    mocks.computeAvailability.mockResolvedValue(days(6));
    const { offerSlots } = await import("@/server/agenda/agent");

    const tarde0 = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      expand: "afternoon",
      cursor: 0,
    });
    const tarde1 = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      expand: "afternoon",
      cursor: 1,
    });

    expect(tarde0.text).toContain("15:00");
    expect(tarde0.text).not.toContain("09:00");
    expect(tarde1.text).not.toBe(tarde0.text);
  });
});

describe("IA-3 — estado del cursor (tenant-safe, con expiración)", () => {
  it("sin fila previa empieza en 0", async () => {
    const { advanceOfferCursor } = await import("@/server/agenda/offer-cursor");

    h.selectQueue.push([]);
    await expect(
      advanceOfferCursor({
        organizationId: "org_a",
        conversationId: "cv_1",
        mode: "next_day",
      })
    ).resolves.toBe(0);
    expect(h.upserts[0]).toMatchObject({ mode: "next_day", cursor: 0 });
  });

  it("misma fila y mismo modo avanza a 1", async () => {
    const { advanceOfferCursor } = await import("@/server/agenda/offer-cursor");

    h.selectQueue.push([
      {
        conversationId: "cv_1",
        organizationId: "org_a",
        mode: "next_day",
        cursor: 0,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);

    await expect(
      advanceOfferCursor({
        organizationId: "org_a",
        conversationId: "cv_1",
        mode: "next_day",
      })
    ).resolves.toBe(1);
  });

  it("cambiar de modo REINICIA el cursor", async () => {
    const { advanceOfferCursor } = await import("@/server/agenda/offer-cursor");

    h.selectQueue.push([
      {
        conversationId: "cv_1",
        organizationId: "org_a",
        mode: "next_day",
        cursor: 3,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);

    await expect(
      advanceOfferCursor({
        organizationId: "org_a",
        conversationId: "cv_1",
        mode: "afternoon",
      })
    ).resolves.toBe(0);
  });

  it("un cursor expirado no gobierna la conversación", async () => {
    const { advanceOfferCursor } = await import("@/server/agenda/offer-cursor");

    h.selectQueue.push([
      {
        conversationId: "cv_1",
        organizationId: "org_a",
        mode: "next_day",
        cursor: 7,
        expiresAt: new Date(Date.now() - 1000),
      },
    ]);

    await expect(
      advanceOfferCursor({
        organizationId: "org_a",
        conversationId: "cv_1",
        mode: "next_day",
      })
    ).resolves.toBe(0);
  });

  it("reset borra el cursor (nueva oferta base)", async () => {
    const { resetOfferCursor } = await import("@/server/agenda/offer-cursor");

    await resetOfferCursor("org_a", "cv_1");
    expect(h.deletes).toBe(1);
  });

  it("la migración 0031 es tenant-safe, con modo y expiración", () => {
    const sql = source("drizzle/0031_agenda_offer_cursor.sql");

    expect(sql).toContain('"organization_id" text NOT NULL');
    expect(sql).toContain('"expires_at" timestamp NOT NULL');
    expect(sql).toContain("agenda_offer_cursor_mode_chk");
    expect(sql).toContain("'next_day', 'morning', 'afternoon', 'weekend'");
  });

  it("el pipeline avanza el cursor al ampliar y lo reinicia en una oferta base", () => {
    const pipeline = source("src/server/ai/pipeline.ts");

    expect(pipeline).toContain("await advanceOfferCursor({");
    expect(pipeline).toContain("mode: expandRequest");
    expect(pipeline).toContain("cursor,");
    expect(pipeline).toContain("await resetOfferCursor(organizationId, conversationId)");
  });
});

describe("QB-06 — la reprogramación deriva la disponibilidad de la cita", () => {
  const client = source("src/components/bookings/bookings-client.tsx");

  it("consulta con el servicio y el profesional DE ESA cita", () => {
    expect(client).toContain("params.set(\"serviceId\", booking.service.id)");
    expect(client).toContain(
      "params.set(\"professionalId\", booking.professional.id)"
    );
    expect(client).toContain("loadRescheduleSlots(booking, null)");
  });

  it("ya no precarga una rejilla general única para todas las citas", () => {
    expect(client).not.toContain('fetch("/api/calendar/availability").catch');
    expect(client).not.toContain("setSlots");
  });

  it("una cita general (sin profesional) usa la disponibilidad general", () => {
    expect(client).toContain("Horarios generales del negocio");
    expect(client).toContain("booking.service?.id && booking.professional?.id");
  });

  it("tiene fecha seleccionable, loading, vacío y error visible", () => {
    expect(client).toContain("Día anterior");
    expect(client).toContain("Día siguiente →");
    expect(client).toContain("Consultando disponibilidad…");
    expect(client).toContain("No hay huecos libres para mover esta cita.");
    expect(client).toContain("No se pudo consultar la disponibilidad de esta cita.");
  });

  it("reprogramar mantiene serviceId/professionalId originales (solo cambia startUtc)", () => {
    expect(client).toContain('action: "reschedule"');
    expect(client).not.toContain("professionalId: null");
  });
});
