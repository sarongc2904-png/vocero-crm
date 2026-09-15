import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fase 1 — corrección a la regresión de domingo, tests obligatorios del
 * reporte (turno completo vía `runAgentTurn`, mismo mecanismo que producción
 * y el Laboratorio):
 *
 *  1. Domingo abierto, el modelo intenta decir "cerrado" → el backend lo impide.
 *  2. "Mejor domingo" → resuelve domingo correcto y consulta esa disponibilidad.
 *  3. Domingo realmente cerrado (sin franjas) → responde cerrado, de verdad.
 *  4. Domingo abierto sin slots → dice "abierto pero sin disponibilidad", NUNCA "cerrado".
 *  5. Cambio de contexto: sábado → "mejor domingo" → targetDate cambia, no
 *     reutiliza los huecos del sábado.
 *  6. Modelo adversarial: aunque el LLM devuelva texto que contradiga la
 *     verdad, el resultado final conserva los datos reales del backend.
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

function resetSettings(weeklyHours: Record<string, { start: string; end: string }[]>) {
  settings = {
    weeklyHours,
    slotMinutes: 30,
    bufferMinutes: 0,
    minNoticeHours: 0,
    maxDaysAhead: 14,
    timezone: "America/Mexico_City",
    connector: "google",
    meetingLink: null,
  };
}

const ABIERTO_TODA_LA_SEMANA = {
  sat: [{ start: "09:00", end: "17:00" }],
  sun: [{ start: "09:00", end: "17:00" }],
};
const SOLO_SABADO = {
  sat: [{ start: "09:00", end: "17:00" }],
  // domingo AUSENTE: cerrado de verdad.
};

const SABADO_ISO = "2026-09-19";
const DOMINGO_ISO = "2026-09-20";
const OTRO_DIA_ISO = "2026-09-21";

const computeAvailability = vi.fn();
const chatJson = vi.fn();

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

// Martes 15-sep-2026 05:00Z — mismo ancla que el resto de la suite de agenda.
const NOW = new Date("2026-09-15T05:00:00.000Z");

function mockComputeAvailability(
  opts: { targetDateWithSlots: Set<string>; slotHourUtc?: string } = { targetDateWithSlots: new Set() }
) {
  computeAvailability.mockImplementation(
    async (_org: string, o?: { fromISO?: string; toISO?: string }) => {
      const consultaDeUnDia = o?.fromISO !== undefined && o.fromISO === o.toISO;
      const hora = opts.slotHourUtc ?? "15:00:00.000Z";
      if (consultaDeUnDia) {
        if (opts.targetDateWithSlots.has(o!.fromISO!)) {
          return [{ startUtc: `${o!.fromISO}T${hora}`, endUtc: `${o!.fromISO}T15:30:00.000Z` }];
        }
        return [];
      }
      // Catálogo general (alternativas), siempre en un día distinto al pedido.
      return [{ startUtc: `${OTRO_DIA_ISO}T${hora}`, endUtc: `${OTRO_DIA_ISO}T15:30:00.000Z` }];
    }
  );
}

describe("guardarraíl de agenda (fix domingo): la verdad de horario es siempre del backend", () => {
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
  afterEach(() => vi.useRealTimers());

  it("Test 1 — domingo abierto: el modelo intenta 'el domingo estamos cerrados' y el backend lo impide", async () => {
    resetSettings(ABIERTO_TODA_LA_SEMANA);
    mockComputeAvailability({ targetDateWithSlots: new Set([DOMINGO_ISO]) });
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { action: "reply", text: "Lo siento, el domingo estamos cerrados. ¿Te gustaría agendar para el sábado?" },
    });
    queueTurno([{ id: "m1", direction: "in", text: "Domingo", createdAt: new Date() }]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const texto = ultimoTextoSaliente();
    expect(texto).not.toMatch(/cerrad/i);
    expect(texto).toContain("20 de septiembre"); // domingo real, con slots reales
    expect(texto).toContain("09:00");
  });

  it("Test 2 — 'Mejor domingo' resuelve la fecha correcta y consulta disponibilidad real de ESE día", async () => {
    resetSettings(ABIERTO_TODA_LA_SEMANA);
    mockComputeAvailability({ targetDateWithSlots: new Set([DOMINGO_ISO]) });
    chatJson.mockResolvedValueOnce({ ok: true, data: { action: "reply", text: "Claro, ¿a qué hora?" } });
    queueTurno([{ id: "m1", direction: "in", text: "Mejor domingo", createdAt: new Date() }]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const consultaDelDia = computeAvailability.mock.calls.find(
      (c) =>
        (c[1] as { fromISO?: string })?.fromISO !== undefined &&
        (c[1] as { fromISO?: string })?.fromISO === (c[1] as { toISO?: string })?.toISO
    );
    expect((consultaDelDia?.[1] as { fromISO?: string })?.fromISO).toBe(DOMINGO_ISO);
    expect(ultimoTextoSaliente()).toContain("09:00");
  });

  it("Test 3 — domingo REALMENTE cerrado (sin franjas configuradas) → sí debe decir cerrado", async () => {
    resetSettings(SOLO_SABADO);
    mockComputeAvailability({ targetDateWithSlots: new Set() }); // nada, ni siquiera lo consultado
    chatJson.mockResolvedValueOnce({ ok: true, data: { action: "reply", text: "Sí, claro, ¿qué hora te acomoda?" } });
    queueTurno([{ id: "m1", direction: "in", text: "¿Abren domingo?", createdAt: new Date() }]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const texto = ultimoTextoSaliente();
    expect(texto).toMatch(/estamos cerrados/i);
    expect(texto).toContain("20 de septiembre");
  });

  it("Test 4 — domingo abierto pero sin cupos → dice ABIERTO sin disponibilidad, jamás 'cerrado'", async () => {
    resetSettings(ABIERTO_TODA_LA_SEMANA);
    mockComputeAvailability({ targetDateWithSlots: new Set() }); // domingo sin cupo; catálogo general en OTRO_DIA
    chatJson.mockResolvedValueOnce({ ok: true, data: { action: "offer_slots", reply: "Ahí te va:" } });
    queueTurno([{ id: "m1", direction: "in", text: "Domingo", createdAt: new Date() }]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const texto = ultimoTextoSaliente();
    expect(texto).not.toMatch(/estamos cerrados/i);
    expect(texto).toMatch(/Sí abrimos/);
    expect(texto).toContain("09:00 a 17:00");
    expect(texto).toContain("pero ya no tengo horarios disponibles ese día");
  });

  it("Test 5 — cambio de contexto: sábado → 'mejor domingo' — targetDate cambia, no reusa huecos del sábado", async () => {
    resetSettings(ABIERTO_TODA_LA_SEMANA);
    mockComputeAvailability({ targetDateWithSlots: new Set([SABADO_ISO, DOMINGO_ISO]) });

    // Turno 1: pide sábado.
    chatJson.mockResolvedValueOnce({ ok: true, data: { action: "offer_slots", reply: "Para el sábado:" } });
    queueTurno([{ id: "m1", direction: "in", text: "Quiero el sábado", createdAt: new Date() }]);
    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");
    const consultaSabado = computeAvailability.mock.calls.find(
      (c) => (c[1] as { fromISO?: string })?.fromISO === SABADO_ISO
    );
    expect(consultaSabado).toBeDefined();

    // Turno 2: cambia a domingo — debe consultar domingo, no reciclar sábado.
    computeAvailability.mockClear();
    chatJson.mockResolvedValueOnce({ ok: true, data: { action: "reply", text: "Ok" } });
    queueTurno([
      { id: "m2", direction: "in", text: "Mejor domingo", createdAt: new Date() },
      { id: "m1", direction: "in", text: "Quiero el sábado", createdAt: new Date() },
    ]);
    await runAgentTurn("cv_lab");
    const consultaDomingo = computeAvailability.mock.calls.find(
      (c) =>
        (c[1] as { fromISO?: string })?.fromISO !== undefined &&
        (c[1] as { fromISO?: string })?.fromISO === (c[1] as { toISO?: string })?.toISO
    );
    expect((consultaDomingo?.[1] as { fromISO?: string })?.fromISO).toBe(DOMINGO_ISO);
    expect(ultimoTextoSaliente()).toContain("20 de septiembre");
    expect(ultimoTextoSaliente()).not.toContain("19 de septiembre");
  });

  it("Test 6 — modelo adversarial: aunque devuelva factualidad falsa, la salida final es 100% del backend", async () => {
    resetSettings(ABIERTO_TODA_LA_SEMANA);
    mockComputeAvailability({ targetDateWithSlots: new Set([DOMINGO_ISO]) });
    // El modelo miente en DOS frentes: dice que está cerrado Y promete un
    // horario inventado que no existe en ningún lado.
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: {
        action: "reply",
        text: "Lo siento, el domingo estamos cerrados, pero te puedo dar las 3:00pm de todos modos si quieres.",
      },
    });
    queueTurno([{ id: "m1", direction: "in", text: "Domingo", createdAt: new Date() }]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const texto = ultimoTextoSaliente();
    expect(texto).not.toMatch(/cerrad/i);
    expect(texto).not.toContain("3:00pm");
    expect(texto).not.toContain("todos modos");
    // Lo único que sobrevive es la fecha/horario que el backend calculó de verdad.
    expect(texto).toContain("20 de septiembre");
    expect(texto).toContain("09:00");
  });
});
