import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * Tenant A / Tenant B — IA (handoff, move_stage) y agenda (ofertas, acciones
 * pendientes, servicio/profesional).
 *
 * Se ejecuta como ORG_A con ids de B sobre una base vacía y se exige que cada
 * WHERE esté ligado a ORG_A y que no haya escrituras.
 */

const ORG_A = "org_A";
const ORG_B = "org_B";

const h = vi.hoisted(() => ({ wheres: [] as unknown[], writes: 0 }));

function chain(rows: unknown[], write = false) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "orderBy", "limit", "innerJoin", "leftJoin", "set"]) {
    c[m] = () => c;
  }
  c.where = (w: unknown) => {
    h.wheres.push(w);
    return c;
  };
  c.returning = () => Promise.resolve(rows);
  (c as { then: unknown }).then = (res: (v: unknown) => void) => {
    if (write) h.writes += 1;
    return Promise.resolve(rows).then(res);
  };
  return c;
}

const fakeDb = {
  select: () => chain([]),
  update: () => chain([], true),
  delete: () => chain([], true),
  insert: () => ({ values: () => chain([], true) }),
  transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb),
};

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return { ...original, getDb: () => fakeDb };
});
vi.mock("@/server/events/bus", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/events/bus")>();
  return { ...original, publish: () => {} };
});

const dialect = new PgDialect();
const params = (i = 0) => dialect.sqlToQuery(h.wheres[i] as SQL).params;

function expectScopedToA(i = 0) {
  expect(params(i)).toContain(ORG_A);
  expect(params(i)).not.toContain(ORG_B);
}

beforeEach(() => {
  h.wheres.length = 0;
  h.writes = 0;
});

describe("IA", () => {
  it("handoff: A no puede pausar la IA de una conversación de B", async () => {
    const { applyHandoff } = await import("@/server/ai/pipeline");
    expect(await applyHandoff("conv_of_B", ORG_A, "cliente")).toBe(false);
    expectScopedToA();
    expect(params()).toContain("conv_of_B");
  }, 30_000);

  it("move_stage: una etapa de B no se acepta para un lead de A", async () => {
    // El lead existe en A, pero la etapa pedida no pertenece a A.
    const calls: unknown[][] = [
      [{ lead: { id: "lead_A", stageId: "stage_A1" }, stage: null }],
      [], // la etapa destino no existe dentro de A
    ];
    fakeDb.select = () => chain(calls.shift() ?? []);
    const { moveLeadToStage } = await import("@/server/leads/stage-history");
    const res = await moveLeadToStage({
      organizationId: ORG_A,
      leadId: "lead_A",
      toStageId: "stage_of_B",
      source: "bot",
    });
    expect(res).toEqual({ ok: false, reason: "stage_not_found" });
    expect(h.writes).toBe(0);
    expectScopedToA(1);
    expect(params(1)).toContain("stage_of_B");
  });
});

describe("Agenda", () => {
  beforeEach(() => {
    fakeDb.select = () => chain([]);
  });

  it("ofertas: A no lee ni borra las ofertas de una conversación de B", async () => {
    const { getOffers, clearOffers } = await import("@/server/agenda/offers");
    expect(await getOffers(ORG_A, "conv_of_B")).toEqual([]);
    expectScopedToA(0);
    await clearOffers(ORG_A, "conv_of_B");
    expectScopedToA(1);
  });

  it("acciones pendientes: A no lee ni borra las de una conversación de B", async () => {
    const { getPendingAction, clearPendingAction } = await import(
      "@/server/agenda/pending-actions"
    );
    expect(await getPendingAction(ORG_A, "conv_of_B")).toBeNull();
    expectScopedToA(0);
    await clearPendingAction(ORG_A, "conv_of_B");
    expectScopedToA(h.wheres.length - 1);
  });

  it("servicio/profesional de B no forman contexto de agenda para A", async () => {
    const { getSchedulingContext } = await import(
      "@/server/agenda/professional-availability"
    );
    const { BeautyCatalogError } = await import("@/server/beauty/catalog");
    await expect(
      getSchedulingContext({
        organizationId: ORG_A,
        serviceId: "service_of_B",
        professionalId: "professional_of_B",
      })
    ).rejects.toBeInstanceOf(BeautyCatalogError);
    expectScopedToA();
    expect(params()).toContain("service_of_B");
  });
});
