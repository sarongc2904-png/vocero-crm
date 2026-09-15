import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fase 1 — bug de rangos ("de lunes a domingo" devolvía solo lunes). Tests
 * obligatorios del reporte, vía `runAgentTurn` (el mismo pipeline real de
 * producción y el Laboratorio):
 *
 *  - "de lunes a domingo" → varios días representados, no solo lunes.
 *  - "dame todos los horarios disponibles" → disponibilidad útil, sin pedir
 *    un día específico cuando sí hay algo que mostrar.
 *  - límite de slots → se reparte entre días, no se agota en el primero.
 */

let settings: {
  weeklyHours: Record<string, { start: string; end: string }[]>;
  slotMinutes: number;
  bufferMinutes: number;
  minNoticeHours: number;
  maxDaysAhead: number;
  timezone: string;
  connector: "google";
  meetingLink: string | null;
};

function resetSettings() {
  settings = {
    weeklyHours: {
      mon: [{ start: "09:00", end: "17:00" }],
      tue: [{ start: "09:00", end: "17:00" }],
      wed: [{ start: "09:00", end: "17:00" }],
      thu: [{ start: "09:00", end: "17:00" }],
      fri: [{ start: "09:00", end: "17:00" }],
      sat: [{ start: "09:00", end: "17:00" }],
      sun: [{ start: "09:00", end: "17:00" }],
    },
    slotMinutes: 30,
    bufferMinutes: 0,
    minNoticeHours: 0,
    maxDaysAhead: 14,
    timezone: "America/Mexico_City",
    connector: "google",
    meetingLink: null,
  };
}

// Disponibilidad real en lunes, martes, jueves y domingo (deliberadamente
// SIN miércoles/sábado, para probar que el reparto salta los días vacíos sin
// romperse) — mismo ancla que el resto de la suite: hoy = lunes 14-sep-2026.
const DIAS_CON_CUPO: Record<string, string[]> = {
  "2026-09-14": ["09:00:00.000Z", "09:45:00.000Z", "10:30:00.000Z", "11:15:00.000Z", "12:00:00.000Z"],
  "2026-09-15": ["09:00:00.000Z", "09:45:00.000Z"],
  "2026-09-17": ["09:00:00.000Z", "09:45:00.000Z", "10:30:00.000Z"],
  "2026-09-20": ["09:00:00.000Z"],
};

const computeAvailability = vi.fn();
const chatJson = vi.fn();

function mockDisponibilidadReal() {
  computeAvailability.mockImplementation(async (_org: string, opts?: { fromISO?: string; toISO?: string }) => {
    const out: { startUtc: string; endUtc: string }[] = [];
    for (const [dia, horas] of Object.entries(DIAS_CON_CUPO)) {
      if (opts?.fromISO && dia < opts.fromISO) continue;
      if (opts?.toISO && dia > opts.toISO) continue;
      for (const h of horas) {
        out.push({ startUtc: `${dia}T${h}`, endUtc: `${dia}T${h}` });
      }
    }
    // computeAvailability real devuelve ordenado ascendente.
    return out.sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
  });
}

vi.mock("@/lib/ai", () => ({ chatJson: (...args: unknown[]) => chatJson(...args) }));
vi.mock("@/server/agenda/settings", () => ({ getSettings: async () => settings }));
vi.mock("@/server/agenda/availability", () => ({
  computeAvailability: (...args: unknown[]) =>
    computeAvailability(...(args as [string, object | undefined])),
}));
vi.mock("@/server/agenda/offers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/offers")>();
  return { ...original, getOffers: async () => [], replaceOffers: async () => {} };
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
  const salida = [...inserts].reverse().find((i) => (i.values as { direction?: string }).direction === "out");
  return (salida?.values as { text?: string })?.text ?? "";
}

// Lunes 14-sep-2026 18:00Z = mediodía en America/Mexico_City — "hoy" para
// toda esta suite es el lunes, igual que el resto de tests de agenda.
const NOW = new Date("2026-09-14T18:00:00.000Z");

describe("guardarraíl de agenda — bug de rangos: reparto por día, no slice() del primero", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    selectQueue.length = 0;
    inserts.length = 0;
    chatJson.mockReset();
    computeAvailability.mockClear();
    resetSettings();
    mockDisponibilidadReal();
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("AGENDA", "on");
  });
  afterEach(() => vi.useRealTimers());

  it("'de lunes a domingo' representa VARIOS días (lunes, martes, jueves, domingo), no solo lunes", async () => {
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { action: "reply", text: "¿Qué día específico te gustaría agendar?" },
    });
    queueTurno([{ id: "m1", direction: "in", text: "De lunes a domingo", createdAt: new Date() }]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const texto = ultimoTextoSaliente();
    // Los 4 días con cupo real deben aparecer — nunca solo el lunes.
    expect(texto).toMatch(/lunes/i);
    expect(texto).toMatch(/martes/i);
    expect(texto).toMatch(/jueves/i);
    expect(texto).toMatch(/domingo/i);
    // La consulta a disponibilidad debe haber cubierto el rango completo,
    // no un solo día.
    const consulta = computeAvailability.mock.calls.find(
      (c) => (c[1] as { fromISO?: string })?.fromISO !== undefined
    );
    expect((consulta?.[1] as { fromISO?: string })?.fromISO).toBe("2026-09-14");
    expect((consulta?.[1] as { toISO?: string })?.toISO).toBe("2026-09-20");
  });

  it("'Dame todos los horarios disponibles' NO pregunta '¿qué día?' — muestra disponibilidad útil directamente", async () => {
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { action: "reply", text: "¿Qué día específico te gustaría agendar?" },
    });
    queueTurno([
      { id: "m1", direction: "in", text: "Dame todos los horarios disponibles", createdAt: new Date() },
    ]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const texto = ultimoTextoSaliente();
    expect(texto).not.toMatch(/qué día específico/i);
    expect(texto).toMatch(/lunes|martes|jueves|domingo/i);
    expect(texto).toContain("03:00"); // 09:00 UTC = 03:00 America/Mexico_City
  });

  it("con un tope bajo de slots, el reparto sigue tocando varios días (no se agota el lunes con todo el límite)", async () => {
    // Fuerza un catálogo grande el lunes para que un slice() ingenuo se lo
    // comiera entero si el reparto por día no funcionara.
    computeAvailability.mockImplementation(async (_org: string, opts?: { fromISO?: string; toISO?: string }) => {
      const out: { startUtc: string; endUtc: string }[] = [];
      const lunesHoras = Array.from({ length: 10 }, (_, i) => `${String(9 + i).padStart(2, "0")}:00:00.000Z`);
      const dias: Record<string, string[]> = {
        "2026-09-14": lunesHoras, // 10 huecos, muchos más que cualquier tope por día
        "2026-09-17": ["09:00:00.000Z", "09:45:00.000Z"],
        "2026-09-20": ["09:00:00.000Z"],
      };
      for (const [dia, horas] of Object.entries(dias)) {
        if (opts?.fromISO && dia < opts.fromISO) continue;
        if (opts?.toISO && dia > opts.toISO) continue;
        for (const h of horas) out.push({ startUtc: `${dia}T${h}`, endUtc: `${dia}T${h}` });
      }
      return out.sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
    });

    chatJson.mockResolvedValueOnce({ ok: true, data: { action: "reply", text: "..." } });
    queueTurno([{ id: "m1", direction: "in", text: "De lunes a domingo", createdAt: new Date() }]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const texto = ultimoTextoSaliente();
    // Con el lunes solo ya alcanzaría cualquier tope total razonable — si el
    // reparto fuera un slice() global, jueves/domingo jamás aparecerían.
    expect(texto).toMatch(/jueves/i);
    expect(texto).toMatch(/domingo/i);
  });
});
