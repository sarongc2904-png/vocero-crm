import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ONB-1 — La ruta que carga la demo no puede escribir sin confirmación
 * explícita, y debe decir QUÉ se perdería cuando rechaza.
 */

const state = vi.hoisted(() => ({
  blockers: [] as string[],
  seedCalls: 0,
}));

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    // El gate de sesión/rol ya tiene sus propias pruebas; aquí interesa el
    // comportamiento de la ruta una vez autenticado como owner.
    withOrgRoles: (
      _roles: unknown,
      handler: (session: unknown, ...args: unknown[]) => Promise<Response>
    ) => {
      return (...args: unknown[]) =>
        handler({ organizationId: "org_1", role: "owner" }, ...args);
    },
  };
});
vi.mock("@/server/seed/demo", () => ({
  DEMO_SEED_BLOCKER_LABEL: { kb: "conocimiento cargado", lab: "Laboratorio" },
  getDemoSeedBlockers: async () => state.blockers,
  seedDemo: async () => {
    state.seedCalls++;
    return { contacts: 8, kbEntries: 12 };
  },
}));

describe("ONB-1 · ruta POST /api/seed/demo", () => {

  async function post(body?: unknown) {
    const { POST } = await import("@/app/api/seed/demo/route");
    return POST(
      new Request("http://localhost:3000/api/seed/demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    );
  }

  beforeEach(() => {
    state.blockers = [];
    state.seedCalls = 0;
  });

  it("sin confirmación explícita no escribe nada", async () => {
    const sinCuerpo = await post();
    const conConfirmFalso = await post({ confirm: false });

    expect(sinCuerpo.status).toBe(400);
    expect(conConfirmFalso.status).toBe(400);
    expect((await sinCuerpo.json()).error.code).toBe("confirmation_required");
    expect(state.seedCalls).toBe(0);
  });

  it("si algo se perdería, rechaza y ENUMERA qué: 409 sin escribir", async () => {
    state.blockers = ["kb", "lab"];

    const response = await post({ confirm: true });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("not_empty");
    expect(body.error.message).toContain("conocimiento cargado");
    expect(body.error.message).toContain("Laboratorio");
    expect(state.seedCalls).toBe(0);
  });

  it("con organización vacía y confirmación, carga la demo una vez", async () => {
    const response = await post({ confirm: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      contacts: 8,
      kbEntries: 12,
    });
    expect(state.seedCalls).toBe(1);
  });
});
