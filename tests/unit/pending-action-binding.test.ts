import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * Una pendiente solo es ejecutable si, en la MISMA sentencia que la borra:
 * sigue vigente, está ligada al último mensaje saliente de la conversación
 * (la pregunta que la creó), no hubo handoff ni reinicio de sesión desde que
 * se creó y, para cancelar o reprogramar, guarda la cita (`booking_id`).
 * La prueba con Postgres real (`booking-confirmation-postgres.test.ts`) lo
 * ejercita de punta a punta; aquí se fija la forma del SQL para CI.
 */

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  where: [] as unknown[],
  inserts: [] as Record<string, unknown>[],
  conflictSet: [] as Record<string, unknown>[],
}));

const fakeDb = {
  delete: () => ({
    where: (condition: unknown) => {
      h.where.push(condition);
      return {
        returning: async () => {
          const out = h.rows;
          h.rows = [];
          return out;
        },
      };
    },
  }),
  insert: () => ({
    values: (values: Record<string, unknown>) => {
      h.inserts.push(values);
      return {
        onConflictDoUpdate: async (config: { set: Record<string, unknown> }) => {
          h.conflictSet.push(config.set);
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
  id: "msg_question",
  organizationId: "org_a",
  conversationId: "cv_1",
  action: "cancel",
  bookingId: "bk_1",
  startUtc: null,
  serviceId: null,
  professionalId: null,
  createdAt: new Date("2026-10-06T21:30:00.000Z"),
  expiresAt: new Date("2026-10-06T22:00:00.000Z"),
};

beforeEach(() => {
  h.rows = [];
  h.where = [];
  h.inserts = [];
  h.conflictSet = [];
});

describe("setPendingAction liga la pendiente a su pregunta", () => {
  it("el id de la pendiente es el id del mensaje de la pregunta, también al reemplazar", async () => {
    const { setPendingAction } = await import("@/server/agenda/pending-actions");
    await setPendingAction({
      organizationId: "org_a",
      conversationId: "cv_1",
      action: "cancel",
      bookingId: "bk_1",
      questionMessageId: "msg_question",
    });
    expect(h.inserts[0]).toMatchObject({ id: "msg_question", bookingId: "bk_1" });
    expect(h.conflictSet[0]).toMatchObject({ id: "msg_question", bookingId: "bk_1" });
  });

  it("sin pregunta, el id no es de ningún mensaje (nunca será ejecutable)", async () => {
    const { setPendingAction } = await import("@/server/agenda/pending-actions");
    await setPendingAction({ organizationId: "org_a", conversationId: "cv_1", action: "cancel" });
    expect(String(h.inserts[0]!.id)).toMatch(/^paa_/);
  });
});

describe("consumePendingAction: todas las condiciones en la sentencia que borra", () => {
  it("vigencia, último saliente, sesión/handoff y cita para cancelar o reprogramar", async () => {
    const { consumePendingAction } = await import("@/server/agenda/pending-actions");
    h.rows = [ROW];
    const now = new Date("2026-10-06T21:45:00.000Z");
    await consumePendingAction("org_a", "cv_1", "msg_in", now);

    const query = new PgDialect().sqlToQuery(h.where[0] as SQL);
    const sql = query.sql.replace(/\s+/g, " ");
    expect(sql).toContain('"pending_agenda_action"."expires_at" > $');
    // (b) ligada al ÚLTIMO mensaje saliente, sea del agente o de un operador:
    // la pregunta existe y ningún otro saliente es posterior ni simultáneo.
    expect(sql).toContain('from "message" as q where q."id" = "pending_agenda_action"."id"');
    expect(sql).toContain(`q."direction" = 'out'`);
    expect(sql).toContain(
      `not exists (select 1 from "message" as o where o."organization_id" = $`
    );
    expect(sql).toContain(`o."id" <> q."id" and o."created_at" >= q."created_at"`);
    // (c) sin handoff ni reinicio de sesión desde que se creó.
    expect(sql).toContain('"conversation"."handoff_at" is null');
    expect(sql).toMatch(/"conversation"\."ai_context_reset_at" < "pending_agenda_action"\."created_at"/);
    // (a) cancelar y reprogramar necesitan la cita.
    expect(sql).toMatch(/"pending_agenda_action"\."action" = 'book' or "pending_agenda_action"\."booking_id" is not null/);
    expect(query.params).toContain("org_a");
    expect(query.params).toContain("cv_1");
  });

  it("defensa: una fila de cancelar sin cita no se ejecuta aunque la BD la devolviera", async () => {
    const { consumePendingAction } = await import("@/server/agenda/pending-actions");
    h.rows = [{ ...ROW, bookingId: null }];
    await expect(
      consumePendingAction("org_a", "cv_1", "msg_in", new Date("2026-10-06T21:45:00.000Z"))
    ).resolves.toBeNull();
  });
});
