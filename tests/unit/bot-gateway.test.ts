import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeFicha, normalizeFicha } from "@/server/bot/ficha";
import { toHandoffReason } from "@/server/bot/handoff";
import { resetRateLimit } from "@/lib/rate-limit";

/** La puerta de toda la superficie `/api/bot/*`. */

const KEY_ORG_A = "clave-de-la-organizacion-a-0123456789abcdef";
const KEY_ORG_B = "clave-de-la-organizacion-b-fedcba9876543210";

function reqWith(key?: string): Request {
  return new Request("http://localhost/api/bot/context", {
    headers: key ? { "x-api-key": key } : {},
  });
}

/**
 * Fase 1 — la clave YA NO vive en una env var de instancia: cada organización
 * tiene la suya (`bot_api_key`). Se mockea `resolveOrgByApiKey` para simular
 * DOS organizaciones simultáneas sin necesitar Postgres — es la prueba de
 * regresión de la fuga que tenía `resolveInstanceOrg()` ("la primera fila de
 * `organization`", la misma para cualquier clave).
 */
vi.mock("@/server/bot/api-keys", () => ({
  resolveOrgByApiKey: async (key: string) => {
    if (key === KEY_ORG_A) return "org_a";
    if (key === KEY_ORG_B) return "org_b";
    return null;
  },
}));

describe("authenticateBotRequest — aislamiento multi-tenant", () => {
  beforeEach(() => {
    resetRateLimit();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("la clave de la organización A resuelve A, nunca B", async () => {
    const { authenticateBotRequest } = await import("@/server/bot/auth");
    const res = await authenticateBotRequest(reqWith(KEY_ORG_A));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.organizationId).toBe("org_a");
  });

  it("la clave de la organización B resuelve B, nunca A", async () => {
    const { authenticateBotRequest } = await import("@/server/bot/auth");
    const res = await authenticateBotRequest(reqWith(KEY_ORG_B));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.organizationId).toBe("org_b");
  });

  it("una clave que no pertenece a ninguna organización → 401 (nunca cae a una por defecto)", async () => {
    const { authenticateBotRequest } = await import("@/server/bot/auth");
    const res = await authenticateBotRequest(reqWith("clave-que-no-existe-en-ninguna-org"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(401);
  });

  it("sin header → 401", async () => {
    const { authenticateBotRequest } = await import("@/server/bot/auth");
    const res = await authenticateBotRequest(reqWith());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(401);
  });
});

describe("normalizeFicha (tolerante al drift del LLM)", () => {
  it("las claves las pone el negocio, no el CRM", () => {
    expect(
      normalizeFicha({ tratamiento: "ortodoncia", metros: 120, urgente: true })
    ).toEqual({ tratamiento: "ortodoncia", metros: 120, urgente: true });
  });

  it("recorta espacios y trunca a 500 caracteres", () => {
    const out = normalizeFicha({ notas: "  hola  ", largo: "x".repeat(900) });
    expect(out.notas).toBe("hola");
    expect((out.largo as string).length).toBe(500);
  });

  it("la cadena vacía se descarta; null explícito sobrevive para borrar", () => {
    const out = normalizeFicha({ rubro: "", geo: null });
    expect("rubro" in out).toBe(false);
    expect(out.geo).toBeNull();
  });

  it("objetos y arreglos se ignoran sin reventar", () => {
    expect(normalizeFicha({ nested: { a: 1 }, lista: [1, 2], ok: "sí" })).toEqual({
      ok: "sí",
    });
  });

  it("números no finitos fuera; el cero sí es un dato", () => {
    expect(normalizeFicha({ a: Number.NaN, b: Infinity, empleados: 0 })).toEqual({
      empleados: 0,
    });
  });

  it("claves vacías o larguísimas se descartan", () => {
    const out = normalizeFicha({ "  ": "x", ["k".repeat(80)]: "y", bien: "z" });
    expect(out).toEqual({ bien: "z" });
  });

  it("un bot en bucle no puede inflar la ficha sin límite", () => {
    const raw: Record<string, string> = {};
    for (let i = 0; i < 200; i++) raw[`campo${i}`] = "v";
    expect(Object.keys(normalizeFicha(raw)).length).toBe(40);
  });
});

describe("toHandoffReason (el handoff nunca se pierde por el motivo)", () => {
  it("los motivos del catálogo pasan tal cual", () => {
    for (const r of ["cliente", "modelo", "error", "ventana", "hostilidad"]) {
      expect(toHandoffReason(r)).toBe(r);
    }
  });

  it("un motivo inventado por el LLM cae a 'modelo' en vez de tirar el handoff", () => {
    expect(toHandoffReason("porque el señor se enojó")).toBe("modelo");
  });

  it("ausente o vacío también cae a 'modelo'", () => {
    expect(toHandoffReason(undefined)).toBe("modelo");
    expect(toHandoffReason("   ")).toBe("modelo");
  });

  it("tolera mayúsculas y espacios de sobra", () => {
    expect(toHandoffReason("  Hostilidad ")).toBe("hostilidad");
  });
});

describe("mergeFicha", () => {
  it("lo ausente se conserva y lo nuevo se agrega", () => {
    expect(mergeFicha({ rubro: "dentista" }, { geo: "Querétaro" })).toEqual({
      rubro: "dentista",
      geo: "Querétaro",
    });
  });

  it("un valor nuevo pisa al viejo", () => {
    expect(mergeFicha({ geo: "CDMX" }, { geo: "Querétaro" })).toEqual({
      geo: "Querétaro",
    });
  });

  it("null borra la clave en vez de guardarla en null", () => {
    const out = mergeFicha({ rubro: "dentista", geo: "CDMX" }, { geo: null });
    expect(out).toEqual({ rubro: "dentista" });
  });

  it("sin ficha previa parte de cero", () => {
    expect(mergeFicha(null, { a: 1 })).toEqual({ a: 1 });
  });
});
