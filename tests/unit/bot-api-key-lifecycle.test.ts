import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fase 1 — ciclo de vida real de la clave del bot API: emitir, autenticar,
 * rotar, y confirmar que la clave vieja deja de servir mientras la nueva sí.
 * A diferencia de `bot-gateway.test.ts` (que mockea `resolveOrgByApiKey`
 * para probar el gate de auth en aislamiento), este test ejercita la
 * implementación REAL de `src/server/bot/api-keys.ts` contra una base de
 * datos en memoria — es la prueba de que `onConflictDoUpdate` de verdad
 * invalida la clave anterior, no solo que el tipo lo sugiere.
 */

type Row = {
  id: string;
  organizationId: string;
  keyHash: string;
  keyLast4: string;
  lastUsedAt: Date | null;
  createdAt: Date;
};

type Cond = { col: keyof Row; val: unknown };

const rows: Row[] = [];

vi.mock("drizzle-orm", () => ({
  eq: (col: keyof Row, val: unknown): Cond => ({ col, val }),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    insert: () => ({
      values: (v: Partial<Row>) => ({
        onConflictDoUpdate: ({ set }: { set: Partial<Row> }) => {
          const existing = rows.find((r) => r.organizationId === v.organizationId);
          if (existing) Object.assign(existing, set);
          else
            rows.push({
              id: v.id!,
              organizationId: v.organizationId!,
              keyHash: v.keyHash!,
              keyLast4: v.keyLast4!,
              lastUsedAt: null,
              createdAt: new Date(),
            });
          return Promise.resolve();
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: (cond: Cond) => ({
          limit: (n: number) =>
            Promise.resolve(rows.filter((r) => r[cond.col] === cond.val).slice(0, n)),
        }),
      }),
    }),
    update: () => ({
      set: (v: Partial<Row>) => ({
        where: (cond: Cond) => {
          const existing = rows.find((r) => r[cond.col] === cond.val);
          if (existing) Object.assign(existing, v);
          return Promise.resolve();
        },
      }),
    }),
  }),
  schema: {
    botApiKey: {
      id: "id",
      organizationId: "organizationId",
      keyHash: "keyHash",
      keyLast4: "keyLast4",
      lastUsedAt: "lastUsedAt",
    },
  },
}));

beforeEach(() => {
  rows.length = 0;
});

describe("ciclo de vida de la clave del bot API (implementación real)", () => {
  it("emitir → autentica; rotar → la vieja da null, la nueva autentica", async () => {
    const { issueBotApiKey, resolveOrgByApiKey, getBotApiKeyInfo } = await import(
      "@/server/bot/api-keys"
    );

    const first = await issueBotApiKey("org_x");
    expect(first.key).toHaveLength(64); // 32 bytes en hex
    expect(first.last4).toBe(first.key.slice(-4));

    // La clave recién emitida autentica.
    expect(await resolveOrgByApiKey(first.key)).toBe("org_x");

    const infoAfterIssue = await getBotApiKeyInfo("org_x");
    expect(infoAfterIssue?.last4).toBe(first.last4);
    // resolveOrgByApiKey ya la usó una vez: lastUsedAt quedó marcado.
    expect(infoAfterIssue?.lastUsedAt).not.toBeNull();

    // Rotar: solo puede haber UNA fila viva por organización.
    const second = await issueBotApiKey("org_x");
    expect(second.key).not.toBe(first.key);
    expect(rows.filter((r) => r.organizationId === "org_x")).toHaveLength(1);

    // La clave vieja ya no resuelve a nada — el gate HTTP la traduce a 401.
    expect(await resolveOrgByApiKey(first.key)).toBeNull();
    // La clave nueva sí.
    expect(await resolveOrgByApiKey(second.key)).toBe("org_x");

    const infoAfterRotate = await getBotApiKeyInfo("org_x");
    expect(infoAfterRotate?.last4).toBe(second.last4);
  });

  it("dos organizaciones nunca comparten ni cruzan claves", async () => {
    const { issueBotApiKey, resolveOrgByApiKey } = await import("@/server/bot/api-keys");

    const a = await issueBotApiKey("org_a");
    const b = await issueBotApiKey("org_b");

    expect(await resolveOrgByApiKey(a.key)).toBe("org_a");
    expect(await resolveOrgByApiKey(b.key)).toBe("org_b");

    // Rotar A no toca a B.
    const a2 = await issueBotApiKey("org_a");
    expect(await resolveOrgByApiKey(a.key)).toBeNull();
    expect(await resolveOrgByApiKey(a2.key)).toBe("org_a");
    expect(await resolveOrgByApiKey(b.key)).toBe("org_b");
  });

  it("clave inexistente o demasiado corta nunca resuelve organización", async () => {
    const { resolveOrgByApiKey } = await import("@/server/bot/api-keys");
    expect(await resolveOrgByApiKey("no-existe-para-nadie-0000000000")).toBeNull();
    expect(await resolveOrgByApiKey("corta")).toBeNull();
  });
});

describe("authenticateBotRequest sobre la implementación real (no mockeada)", () => {
  // El primer `authenticateBotRequest` de la suite paga el arranque en frío
  // del módulo de auth (mismo costo que ya se ve en bot-gateway.test.ts):
  // bajo contención de CPU con toda la suite corriendo en paralelo, 5s no
  // siempre alcanzan — timeout explícito, no lógica de negocio.
  it("clave vieja tras rotar → 401; clave nueva → 200 vía el gate HTTP real", { timeout: 20_000 }, async () => {
    const { resetRateLimit } = await import("@/lib/rate-limit");
    resetRateLimit();
    const { issueBotApiKey } = await import("@/server/bot/api-keys");
    const { authenticateBotRequest } = await import("@/server/bot/auth");

    const first = await issueBotApiKey("org_live");
    const reqOld = new Request("http://localhost/api/bot/context", {
      headers: { "x-api-key": first.key },
    });
    const okFirst = await authenticateBotRequest(reqOld);
    expect(okFirst.ok).toBe(true);

    const second = await issueBotApiKey("org_live");

    const reqOldAfterRotate = new Request("http://localhost/api/bot/context", {
      headers: { "x-api-key": first.key },
    });
    const oldAfterRotate = await authenticateBotRequest(reqOldAfterRotate);
    expect(oldAfterRotate.ok).toBe(false);
    if (!oldAfterRotate.ok) expect(oldAfterRotate.response.status).toBe(401);

    const reqNew = new Request("http://localhost/api/bot/context", {
      headers: { "x-api-key": second.key },
    });
    const okNew = await authenticateBotRequest(reqNew);
    expect(okNew.ok).toBe(true);
    if (okNew.ok) expect(okNew.organizationId).toBe("org_live");
  });
});
