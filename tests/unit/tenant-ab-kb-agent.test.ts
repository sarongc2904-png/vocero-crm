import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * Tenant A / Tenant B — KB y perfil del agente.
 *
 * Renderiza el WHERE real de cada query y exige que lleve el organizationId de
 * la sesión (A). Si alguien quita `scoped(...)`, el SQL deja de contener
 * ORG_A y el test falla. Una fila de B nunca puede coincidir con ese WHERE.
 */

const ORG_A = "org_A";
const ORG_B = "org_B";

const h = vi.hoisted(() => ({
  wheres: [] as unknown[],
  session: { org: "org_A" },
}));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = () => c;
  c.where = (w: unknown) => {
    h.wheres.push(w);
    return c;
  };
  c.orderBy = () => c;
  c.limit = () => c;
  c.set = () => c;
  c.returning = () => Promise.resolve(rows);
  (c as { then: unknown }).then = (res: (v: unknown) => void) =>
    Promise.resolve(rows).then(res);
  return c;
}

const fakeDb = {
  select: () => chain([]),
  update: () => chain([]),
  delete: () => chain([]),
};

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return { ...original, getDb: () => fakeDb };
});
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    ...original,
    requireSession: async () => ({
      userId: "u1",
      organizationId: h.session.org,
      role: "owner",
      isSuperadmin: false,
    }),
  };
});
vi.mock("@/server/commercial/entitlement", () => ({
  getCommercialAccess: async () => ({ allowed: true }),
}));
vi.mock("@/server/auth/audit", () => ({ auditPrivilegedAction: async () => {} }));

const dialect = new PgDialect();
function render(w: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(w as SQL);
}

beforeEach(() => {
  h.wheres.length = 0;
  h.session.org = ORG_A;
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (body: unknown) =>
  new Request("http://x/api", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("A no ve ni edita KB / perfil de B", () => {
  it("PATCH /api/kb/:id con id de B filtra por ORG_A y devuelve 404", async () => {
    const { PATCH } = await import("@/app/api/kb/[id]/route");
    const res = await PATCH(json({ answer: "hackeado" }), params("kb_of_B"));
    expect(res.status).toBe(404);
    const q = render(h.wheres[0]);
    expect(q.params).toContain(ORG_A);
    expect(q.params).not.toContain(ORG_B);
    expect(q.sql).toContain('"organization_id"');
  }, 30_000);

  it("DELETE /api/kb/:id con id de B filtra por ORG_A y devuelve 404", async () => {
    const { DELETE } = await import("@/app/api/kb/[id]/route");
    const res = await DELETE(new Request("http://x/api"), params("kb_of_B"));
    expect(res.status).toBe(404);
    const q = render(h.wheres[0]);
    expect(q.params).toContain(ORG_A);
    expect(q.sql).toContain('"organization_id"');
  });

  it("GET /api/kb/size solo cuenta KB de la org de la sesión", async () => {
    const { GET } = await import("@/app/api/kb/size/route");
    await (GET as () => Promise<Response>)();
    expect(render(h.wheres[0]).params).toContain(ORG_A);
  });

  it("GET /api/agent/profile lee solo el perfil de la org de la sesión", async () => {
    const { GET } = await import("@/app/api/agent/profile/route");
    const res = await (GET as () => Promise<Response>)();
    expect(res.status).toBe(404);
    expect(render(h.wheres[0]).params).toContain(ORG_A);
  });

  it("cambiar la sesión a B cambia el scope a B (no hay estado cruzado)", async () => {
    h.session.org = ORG_B;
    const { DELETE } = await import("@/app/api/kb/[id]/route");
    await DELETE(new Request("http://x/api"), params("kb_x"));
    const q = render(h.wheres[0]);
    expect(q.params).toContain(ORG_B);
    expect(q.params).not.toContain(ORG_A);
  });
});
