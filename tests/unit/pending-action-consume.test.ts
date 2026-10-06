import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * `consumePendingAction` toma la acción pendiente en UN solo paso:
 * `DELETE … WHERE organización AND conversación AND expires_at > ahora
 * RETURNING`. Dos "sí" concurrentes no pueden ejecutar la misma acción: solo
 * uno recibe la fila. Una acción expirada no se devuelve.
 */

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  where: [] as unknown[],
  returningCalls: 0,
}));

const fakeDb = {
  delete: () => ({
    where: (condition: unknown) => {
      h.where.push(condition);
      return {
        returning: async () => {
          h.returningCalls += 1;
          // Semántica de Postgres: la primera sentencia borra y devuelve; la
          // segunda ya no encuentra la fila.
          const out = h.rows;
          h.rows = [];
          return out;
        },
      };
    },
  }),
};

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return { ...original, getDb: () => fakeDb };
});

const ROW = {
  id: "paa_1",
  organizationId: "org_a",
  conversationId: "cv_1",
  action: "book",
  bookingId: null,
  startUtc: new Date("2026-10-06T22:00:00.000Z"),
  serviceId: "svc_1",
  professionalId: "pro_1",
  createdAt: new Date("2026-10-06T21:30:00.000Z"),
  expiresAt: new Date("2026-10-06T22:00:00.000Z"),
};

beforeEach(() => {
  h.rows = [];
  h.where = [];
  h.returningCalls = 0;
});

describe("consumePendingAction", () => {
  it("borra y devuelve en una sola sentencia con org, conversación y vigencia", async () => {
    const { consumePendingAction } = await import("@/server/agenda/pending-actions");
    h.rows = [ROW];
    const now = new Date("2026-10-06T21:45:00.000Z");

    const pending = await consumePendingAction("org_a", "cv_1", now);

    expect(pending).toMatchObject({
      action: "book",
      startUtc: "2026-10-06T22:00:00.000Z",
      serviceId: "svc_1",
      professionalId: "pro_1",
    });
    expect(h.returningCalls).toBe(1);
    const query = new PgDialect().sqlToQuery(h.where[0] as SQL);
    expect(query.sql).toContain('"pending_agenda_action"."organization_id" = $');
    expect(query.sql).toContain('"pending_agenda_action"."conversation_id" = $');
    expect(query.sql).toContain('"pending_agenda_action"."expires_at" > $');
    expect(query.params).toContain("org_a");
    expect(query.params).toContain("cv_1");
    expect(query.params.some((p) => p instanceof Date || p === now.toISOString())).toBe(true);
  });

  it("dos consumos concurrentes: solo uno recibe la acción", async () => {
    const { consumePendingAction } = await import("@/server/agenda/pending-actions");
    h.rows = [ROW];
    const now = new Date("2026-10-06T21:45:00.000Z");

    const results = await Promise.all([
      consumePendingAction("org_a", "cv_1", now),
      consumePendingAction("org_a", "cv_1", now),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("defensa: si la BD devolviera una fila ya expirada, no se ejecuta", async () => {
    const { consumePendingAction } = await import("@/server/agenda/pending-actions");
    h.rows = [ROW];
    await expect(
      consumePendingAction("org_a", "cv_1", new Date("2026-10-06T22:00:00.000Z"))
    ).resolves.toBeNull();
  });

  it("sin fila vigente devuelve null", async () => {
    const { consumePendingAction } = await import("@/server/agenda/pending-actions");
    await expect(consumePendingAction("org_a", "cv_1")).resolves.toBeNull();
  });
});
