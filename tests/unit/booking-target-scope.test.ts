import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * Cancelar o mover la cita EXACTA de una pendiente (`bookingId`) solo toca esa
 * cita si sigue activa, es de esta conversación o de su contacto y es del
 * mismo negocio. Aquí se fija la forma del WHERE que la busca (para CI, sin
 * base de datos); `booking-confirmation-postgres.test.ts` lo ejercita contra
 * un Postgres real con citas de otro contacto, de otro negocio y canceladas.
 */

const h = vi.hoisted(() => ({
  where: [] as unknown[],
  results: [] as unknown[][],
}));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {
    orderBy: () => c,
    limit: () => Promise.resolve(rows),
    then: (resolve: (v: unknown) => void) => Promise.resolve(rows).then(resolve),
  };
  return c;
}

const fakeDb = {
  select: () => ({
    from: () => ({
      where: (condition: unknown) => {
        h.where.push(condition);
        return chain(h.results.shift() ?? []);
      },
    }),
  }),
};

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return { ...original, getDb: () => fakeDb };
});

vi.mock("@/server/agenda/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/agenda/settings")>()),
  getSettings: async () => ({ timezone: "America/Mexico_City", minNoticeHours: 0 }),
}));

const START = "2026-10-09T23:00:00.000Z";
vi.mock("@/server/agenda/offers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/agenda/offers")>()),
  getOffers: async () => [{ startUtc: START, label: "17:00" }],
  currentOffers: (offers: unknown[]) => offers,
  findOffered: (offers: { startUtc: string }[], startUtc: string) =>
    offers.find((offer) => offer.startUtc === startUtc) ?? null,
}));

const dialect = new PgDialect();

/** `"booking"."columna" = $n` → valor del parámetro (o undefined si no está). */
function equals(condition: unknown, column: string): unknown[] {
  const { sql, params } = dialect.sqlToQuery(condition as SQL);
  const values: unknown[] = [];
  const re = new RegExp(`"booking"\\."${column}" = \\$(\\d+)`, "g");
  for (const match of sql.matchAll(re)) values.push(params[Number(match[1]) - 1]);
  return values;
}

beforeEach(() => {
  h.where = [];
  h.results = [];
});

describe("la cita de la pendiente se busca dentro del negocio y del contacto", () => {
  it("cancelar: negocio, conversación o contacto, y el id exacto en el mismo WHERE", async () => {
    const { cancelBookingForConversation, BookingError } = await import("@/server/agenda/service");
    h.results = [[{ contactId: "ct_1" }], []];
    await expect(
      cancelBookingForConversation({ organizationId: "org_a", conversationId: "cv_1", bookingId: "bk_x" })
    ).rejects.toBeInstanceOf(BookingError);

    const bookingWhere = h.where[1];
    expect(equals(bookingWhere, "organization_id")).toEqual(["org_a"]);
    expect(equals(bookingWhere, "conversation_id")).toEqual(["cv_1"]);
    expect(equals(bookingWhere, "contact_id")).toEqual(["ct_1"]);
    expect(equals(bookingWhere, "id")).toEqual(["bk_x"]);
    expect(equals(bookingWhere, "status")).toEqual(["agendada"]);
  });

  it("reprogramar: negocio, contacto y el id exacto en el mismo WHERE", async () => {
    const { rescheduleForConversation, BookingError } = await import("@/server/agenda/service");
    h.results = [[{ contactId: "ct_1" }], []];
    await expect(
      rescheduleForConversation({
        organizationId: "org_a",
        conversationId: "cv_1",
        startUtc: START,
        bookingId: "bk_x",
      })
    ).rejects.toBeInstanceOf(BookingError);

    const bookingWhere = h.where[1];
    expect(equals(bookingWhere, "organization_id")).toEqual(["org_a"]);
    expect(equals(bookingWhere, "contact_id")).toEqual(["ct_1"]);
    expect(equals(bookingWhere, "id")).toEqual(["bk_x"]);
    expect(equals(bookingWhere, "status")).toEqual(["agendada"]);
  });
});
