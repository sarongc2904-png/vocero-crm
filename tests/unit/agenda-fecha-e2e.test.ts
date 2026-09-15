import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #agenda-fecha — Reproduce el turno completo del Laboratorio (misma función
 * `runAgentTurn` que usa la evaluación real) para el bug reportado en
 * producción: el cliente pregunta por "mañana" y luego por "el jueves", y el
 * agente debía mostrar CADA día por separado, no repetir siempre el primero.
 *
 * No necesita Postgres ni servidor corriendo: mockea la capa de datos igual
 * que tests/unit/lab-sandbox.test.ts, así que corre en `npm test` sin
 * infraestructura.
 */

const NOW = new Date("2026-09-15T05:00:00.000Z");
const JUEVES_ISO = "2026-09-17";
const MARTES_ISO = "2026-09-15"; // lo que trae el catálogo general (el bug)

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

const computeAvailability = vi.fn(
  async (_organizationId: string, opts?: { fromISO?: string; toISO?: string }) => {
    const consultaDeUnDia = opts?.fromISO !== undefined && opts.fromISO === opts.toISO;
    if (consultaDeUnDia) {
      if (opts!.fromISO === JUEVES_ISO) {
        return [{ startUtc: `${JUEVES_ISO}T20:00:00.000Z`, endUtc: `${JUEVES_ISO}T20:30:00.000Z` }];
      }
      return [];
    }
    return [
      { startUtc: `${MARTES_ISO}T08:00:00.000Z`, endUtc: `${MARTES_ISO}T08:30:00.000Z` },
      { startUtc: `${MARTES_ISO}T08:15:00.000Z`, endUtc: `${MARTES_ISO}T08:45:00.000Z` },
      { startUtc: `${MARTES_ISO}T08:30:00.000Z`, endUtc: `${MARTES_ISO}T09:00:00.000Z` },
    ];
  }
);

const chatJson = vi.fn();

vi.mock("@/lib/ai", () => ({ chatJson: (...args: unknown[]) => chatJson(...args) }));
vi.mock("@/server/agenda/settings", () => ({ getSettings: async () => settings }));
vi.mock("@/server/agenda/availability", () => ({
  computeAvailability: (...args: unknown[]) =>
    computeAvailability(...(args as [string, object | undefined])),
}));
vi.mock("@/server/agenda/offers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/offers")>();
  return {
    ...original,
    getOffers: async () => [],
    replaceOffers: async () => {},
  };
});
vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return { ...original, graphRequest: vi.fn() };
});

const selectQueue: unknown[][] = [];
const inserts: { table: unknown; values: Record<string, unknown> }[] = [];

function thenableChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "where", "orderBy", "limit"]) chain[m] = () => chain;
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(rows).then(resolve);
  return chain;
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => thenableChain(selectQueue.shift() ?? []),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        const chain = {
          onConflictDoNothing: () => chain,
          returning: () => Promise.resolve([values]),
          then: (resolve: (v: unknown) => void) => Promise.resolve([values]).then(resolve),
        };
        return chain;
      },
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([{}]),
          then: (resolve: (v: unknown) => void) => Promise.resolve([{}]).then(resolve),
        }),
      }),
    }),
  }),
  schema: new Proxy(
    {},
    {
      get: (_t, tableName) =>
        new Proxy({}, { get: (_t2, col) => `${String(tableName)}.${String(col)}` }),
    }
  ),
}));

const CONVERSACION_DE_PRUEBA = {
  id: "cv_lab",
  organizationId: "org_1",
  contactId: "ct_lab",
  isTest: true,
  aiEnabled: true,
  handoffAt: null,
  handoffReason: null,
  lastInboundAt: new Date(),
};

const PERFIL = {
  id: "agp_1",
  organizationId: "org_1",
  enabled: true,
  name: "Griss",
  tone: null,
  instructions: null,
  escalationRules: null,
  greeting: null,
};

function queueTurno(history: unknown[]) {
  selectQueue.push([CONVERSACION_DE_PRUEBA], [PERFIL], history, [], []);
}

function ultimoTextoSaliente(): string {
  const salida = [...inserts]
    .reverse()
    .find((i) => (i.values as { direction?: string }).direction === "out");
  return (salida?.values as { text?: string })?.text ?? "";
}

describe("Laboratorio simulado: pide 'mañana' y luego 'el jueves' (#agenda-fecha)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    selectQueue.length = 0;
    inserts.length = 0;
    chatJson.mockReset();
    computeAvailability.mockClear();
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("AGENDA", "on");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("turno 1 (mañana): ofrece el catálogo general, sin día pedido", { timeout: 15_000 }, async () => {
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { action: "offer_slots", reply: "Para mañana, tenemos estos horarios disponibles:" },
    });
    queueTurno([
      { id: "m1", direction: "in", text: "Hola, quiero una cita para mañana", createdAt: new Date() },
    ]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(ultimoTextoSaliente()).toContain("08:00");
  });

  it("turno 2 (el jueves): el modelo manda day y el motor consulta ESE día — no repite el martes", { timeout: 15_000 }, async () => {
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: {
        action: "offer_slots",
        day: JUEVES_ISO,
        reply: "Para el jueves, tenemos estos horarios disponibles:",
      },
    });
    // Historial ya con el turno 1 encima (desc: más reciente primero, tal
    // como lo entrega Postgres — `runAgentTurn` lo revierte internamente).
    queueTurno([
      { id: "m3", direction: "in", text: "¿Y el jueves?", createdAt: new Date() },
      { id: "m2", direction: "out", text: "Para mañana, tenemos estos horarios disponibles:\n• mar 08:00", createdAt: new Date() },
      { id: "m1", direction: "in", text: "Hola, quiero una cita para mañana", createdAt: new Date() },
    ]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const texto = ultimoTextoSaliente();
    // Fase 1 (fix domingo): el guardarraíl de `resolveScheduleIntent` descarta
    // el `reply`/intro del modelo por completo cuando el turno menciona una
    // fecha — incluida esta, donde el modelo ya acertaba — para que un intro
    // adversarial nunca pueda contradecir los horarios reales que le siguen.
    expect(texto).toContain("jueves");
    expect(texto).toContain("17 de septiembre");
    expect(texto).toContain("20:00"); // el horario REAL del jueves
    expect(texto).not.toContain("08:00"); // NUNCA el martes del catálogo general — este era el bug
  });
});
