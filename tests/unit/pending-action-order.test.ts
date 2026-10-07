import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * B-1 — Un "sí" solo contesta a la pregunta si llegó DESPUÉS de ella.
 *
 * `consumePendingAction` recibe el mensaje entrante que se está procesando y,
 * en la misma sentencia que borra la pendiente, exige que ese entrante sea de
 * la conversación y que su `created_at` sea POSTERIOR al de la pregunta. Un
 * "sí" guardado mientras el turno que creaba la pregunta seguía en curso (o
 * enviado a un mensaje anterior) no la ejecuta. Además la IA tiene que estar
 * encendida, como con el handoff.
 *
 * Aquí se fija la forma del SQL para CI; `booking-confirmation-postgres.test.ts`
 * lo ejercita contra un Postgres real.
 */

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  where: [] as unknown[],
  deletes: 0,
}));

const fakeDb = {
  delete: () => {
    h.deletes += 1;
    return {
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
    };
  },
};

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return { ...original, getDb: () => fakeDb };
});

const NOW = new Date("2026-10-06T21:45:00.000Z");

beforeEach(() => {
  h.rows = [];
  h.where = [];
  h.deletes = 0;
});

async function consumeSql(inboundMessageId: string) {
  const { consumePendingAction } = await import("@/server/agenda/pending-actions");
  await consumePendingAction("org_a", "cv_1", inboundMessageId, NOW);
  return new PgDialect().sqlToQuery(h.where[0] as SQL);
}

describe("consumePendingAction exige que el 'sí' sea posterior a la pregunta", () => {
  it("liga el entrante procesado: es de la conversación, es entrante y su created_at es mayor que el de la pregunta", async () => {
    const query = await consumeSql("msg_inbound");
    const sql = query.sql.replace(/\s+/g, " ");
    expect(query.params).toContain("msg_inbound");
    // El entrante se busca por id dentro de la misma organización y conversación.
    expect(sql).toMatch(/from "message" as i where i\."id" = \$\d+ and i\."organization_id" = \$\d+ and i\."conversation_id" = \$\d+ and i\."direction" = 'in'/);
    // Orden estricto: un entrante del MISMO instante que la pregunta tampoco cuenta.
    expect(sql).toContain('i."created_at" > q."created_at"');
  });

  it("la condición de orden vive dentro del EXISTS de la pregunta (misma sentencia que el DELETE)", async () => {
    const query = await consumeSql("msg_inbound");
    const sql = query.sql.replace(/\s+/g, " ");
    const question = sql.indexOf('from "message" as q');
    const order = sql.indexOf('i."created_at" > q."created_at"');
    expect(question).toBeGreaterThan(0);
    expect(order).toBeGreaterThan(question);
  });

  it("la IA tiene que estar encendida (pausar la IA invalida la pendiente)", async () => {
    const query = await consumeSql("msg_inbound");
    expect(query.sql).toContain('"conversation"."ai_enabled" = true');
    expect(query.sql).toContain('"conversation"."handoff_at" is null');
  });

  it("sin entrante no hay nada que consumir: devuelve null sin tocar la BD", async () => {
    const { consumePendingAction } = await import("@/server/agenda/pending-actions");
    h.rows = [{ id: "msg_q" }];
    await expect(consumePendingAction("org_a", "cv_1", "", NOW)).resolves.toBeNull();
    expect(h.deletes).toBe(0);
  });
});
