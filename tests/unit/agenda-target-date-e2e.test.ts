import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fase 1 — bug de agenda, turno completo (`runAgentTurn`, la misma función
 * que corre en producción y en el Laboratorio). Complementa
 * `agenda-fecha-e2e.test.ts` (que ya cubre el caso donde el modelo SÍ manda
 * `day` correcto) con los gates que pidió el reporte:
 *
 *  - BUSINESS_HOURS_SOURCE_OF_TRUTH: el prompt lleva el horario REAL de la
 *    fecha detectada, nunca "el modelo lo sabe de memoria".
 *  - TARGET_DATE_SERVER_RESOLUTION / TARGET_DATE_SLOT_FILTERING: el backend
 *    resuelve la fecha del texto del cliente y esa es la que se consulta —
 *    incluso si el modelo manda otra cosa (o nada) en `day`.
 *  - Sábado lleno → alternativas reales, correctamente etiquetadas.
 *  - Cambio de horario en Ajustes se refleja en el siguiente turno sin
 *    redeploy (no hay caché entre `getSettings` y el prompt).
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
resetSettings();

const SABADO_ISO = "2026-09-19";
const OTRO_DIA_ISO = "2026-09-21"; // lunes: catálogo general, distinto al sábado

const computeAvailability = vi.fn(
  async (_organizationId: string, opts?: { fromISO?: string; toISO?: string }) => {
    const consultaDeUnDia = opts?.fromISO !== undefined && opts.fromISO === opts.toISO;
    if (consultaDeUnDia) {
      if (opts!.fromISO === SABADO_ISO) {
        return [
          { startUtc: `${SABADO_ISO}T15:00:00.000Z`, endUtc: `${SABADO_ISO}T15:30:00.000Z` },
        ];
      }
      return []; // sábado lleno / cualquier otro día pedido: sin cupo
    }
    // Catálogo general (alternativas): SIEMPRE otro día, nunca el sábado.
    return [
      { startUtc: `${OTRO_DIA_ISO}T15:00:00.000Z`, endUtc: `${OTRO_DIA_ISO}T15:30:00.000Z` },
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

function ultimoSystemPrompt(): string {
  const call = chatJson.mock.calls[chatJson.mock.calls.length - 1];
  const messages = call?.[1] as { role: string; content: string }[] | undefined;
  return messages?.find((m) => m.role === "system")?.content ?? "";
}

// NOW = martes 15-sep-2026 05:00 UTC. Los tests de fecha (target-date.test.ts)
// ya documentan que eso son las 23:00 del LUNES 14 en esta zona — no importa
// aquí porque todas las expresiones usadas ("sábado", "domingo") resuelven
// igual desde lunes o martes de la misma semana.
const NOW = new Date("2026-09-15T05:00:00.000Z");

describe("runAgentTurn + resolveTargetDate: el backend manda la fecha, nunca el LLM", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    selectQueue.length = 0;
    inserts.length = 0;
    chatJson.mockReset();
    computeAvailability.mockClear();
    resetSettings();
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("AGENDA", "on");
  });
  afterEach(() => vi.useRealTimers());

  it("BUSINESS_HOURS_SOURCE_OF_TRUTH: domingo configurado como abierto → el prompt dice ABIERTO, nunca 'cerrado'", async () => {
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { action: "reply", text: "Sí, el domingo abrimos de 9 a 17." },
    });
    queueTurno([
      { id: "m1", direction: "in", text: "¿Abren el domingo?", createdAt: new Date() },
    ]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const prompt = ultimoSystemPrompt();
    expect(prompt).toContain("targetDate=2026-09-20");
    expect(prompt).toContain("ABIERTO");
    expect(prompt).toContain("09:00-17:00");
    expect(prompt).not.toContain("CERRADO");
  });

  it("TARGET_DATE_SERVER_RESOLUTION: el cliente pide 'sábado' y el modelo NO manda day — el backend igual consulta el sábado real, no el catálogo general", async () => {
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { action: "offer_slots", reply: "Para el sábado, tenemos estos horarios:" },
    });
    queueTurno([
      { id: "m1", direction: "in", text: "Quiero una cita el sábado", createdAt: new Date() },
    ]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const consultaDelDia = computeAvailability.mock.calls.find(
      (c) =>
        (c[1] as { fromISO?: string })?.fromISO !== undefined &&
        (c[1] as { fromISO?: string })?.fromISO === (c[1] as { toISO?: string })?.toISO
    );
    expect((consultaDelDia?.[1] as { fromISO?: string })?.fromISO).toBe(SABADO_ISO);
    expect(ultimoTextoSaliente()).toContain("09:00"); // 15:00 UTC = 09:00 America/Mexico_City
  });

  it("TARGET_DATE_SERVER_RESOLUTION: el modelo manda un day DISTINTO al que el backend resolvió — gana el backend", async () => {
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: {
        action: "offer_slots",
        day: OTRO_DIA_ISO, // el modelo calculó mal — el backend debe ignorarlo
        reply: "Para el sábado, tenemos estos horarios:",
      },
    });
    queueTurno([
      { id: "m1", direction: "in", text: "Quiero una cita el sábado", createdAt: new Date() },
    ]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const consultaDelDia = computeAvailability.mock.calls.find(
      (c) =>
        (c[1] as { fromISO?: string })?.fromISO !== undefined &&
        (c[1] as { fromISO?: string })?.fromISO === (c[1] as { toISO?: string })?.toISO
    );
    expect((consultaDelDia?.[1] as { fromISO?: string })?.fromISO).toBe(SABADO_ISO);
  });

  it("sábado lleno (Caso 3: abierto pero sin cupo) → lo distingue de 'cerrado' y ofrece alternativas con su fecha real", async () => {
    computeAvailability.mockImplementation(async (_org: string, opts?: { fromISO?: string; toISO?: string }) => {
      const consultaDeUnDia = opts?.fromISO !== undefined && opts.fromISO === opts.toISO;
      if (consultaDeUnDia) return []; // el sábado (o cualquier día pedido) está lleno
      return [{ startUtc: `${OTRO_DIA_ISO}T15:00:00.000Z`, endUtc: `${OTRO_DIA_ISO}T15:30:00.000Z` }];
    });
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { action: "offer_slots", reply: "Para el sábado, tenemos estos horarios:" },
    });
    queueTurno([
      { id: "m1", direction: "in", text: "Quiero una cita el sábado", createdAt: new Date() },
    ]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const texto = ultimoTextoSaliente();
    // Caso 3 (fix domingo): el sábado SÍ está configurado abierto, así que la
    // frase debe decirlo explícitamente — nunca el genérico "no tengo
    // horarios" que no distinguía "cerrado" de "abierto pero sin cupo".
    expect(texto).toContain("Sí abrimos");
    expect(texto).toContain("09:00 a 17:00");
    expect(texto).toContain("pero ya no tengo horarios disponibles ese día");
    expect(texto).not.toMatch(/estamos cerrados/i);
    expect(texto).toContain("09:00"); // 15:00 UTC = 09:00 America/Mexico_City, alternativa real
  });

  it("SINGLE_TENANT_BACKWARD_COMPATIBILITY / sin redeploy: cambiar `weeklyHours` entre turnos cambia el HECHO en el siguiente turno, sin reiniciar nada", async () => {
    // Turno 1: domingo cerrado.
    settings.weeklyHours = {};
    chatJson.mockResolvedValueOnce({ ok: true, data: { action: "reply", text: "..." } });
    queueTurno([{ id: "m1", direction: "in", text: "¿abren domingo?", createdAt: new Date() }]);
    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");
    expect(ultimoSystemPrompt()).toContain("CERRADO");

    // El dueño guarda Ajustes → Agenda con domingo abierto — MISMO proceso,
    // sin reiniciar el servidor.
    settings.weeklyHours = { sun: [{ start: "10:00", end: "14:00" }] };
    chatJson.mockResolvedValueOnce({ ok: true, data: { action: "reply", text: "..." } });
    queueTurno([{ id: "m2", direction: "in", text: "¿abren domingo?", createdAt: new Date() }]);
    await runAgentTurn("cv_lab");
    const prompt2 = ultimoSystemPrompt();
    expect(prompt2).toContain("ABIERTO");
    expect(prompt2).toContain("10:00-14:00");
  });
});
