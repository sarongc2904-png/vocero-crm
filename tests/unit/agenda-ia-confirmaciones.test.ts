import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OfferedSlot } from "@/server/agenda/offers";

/**
 * Paquete Agenda / IA — cobertura determinista de:
 *   IA-2  "¿qué horarios tienen el viernes?" es DISPONIBILIDAD, no horario
 *         comercial; "¿a qué hora abren?" sigue siendo horario comercial.
 *   AG-HOLA  un saludo neutral no hereda intención de agenda: ni el prompt lo
 *         empuja a retomar el tema, ni el catálogo de huecos llega al modelo.
 */

const MX = "America/Mexico_City";
const WEEKLY = {
  mon: [{ start: "09:00", end: "18:00" }],
  fri: [{ start: "09:00", end: "18:00" }],
};

async function wantsAvailability(text: string): Promise<boolean> {
  // Import dinámico: `schedule-intent` comparte grafo con `ai/pipeline`, y un
  // import estático aquí crea un ciclo que vitest resuelve con TDZ.
  const { resolveScheduleIntent } = await import(
    "@/server/agenda/schedule-intent"
  );
  const result = resolveScheduleIntent({
    text,
    now: new Date("2026-09-15T18:00:00.000Z"), // martes, mediodía en MX
    weeklyHours: WEEKLY,
    timezone: MX,
  });
  if (result.kind !== "date_mentioned") throw new Error(`sin fecha: ${text}`);
  return result.requiresAvailabilityLookup;
}

describe("IA-2 — horarios del día = disponibilidad, no horario comercial", () => {
  it("las formas habituales de pedir disponibilidad SÍ consultan huecos", async () => {
    await expect(wantsAvailability("¿Qué horarios tienen el viernes?")).resolves.toBe(true);
    await expect(wantsAvailability("¿Hay horarios el viernes?")).resolves.toBe(true);
    await expect(wantsAvailability("¿qué horario tienen el viernes?")).resolves.toBe(true);
    await expect(wantsAvailability("¿Tienen lugar el viernes?")).resolves.toBe(true);
    await expect(wantsAvailability("quiero ver los horarios del viernes")).resolves.toBe(true);
    await expect(wantsAvailability("¿Qué horarios tienes el viernes?")).resolves.toBe(true);
    await expect(wantsAvailability("el viernes")).resolves.toBe(true);
  });

  it("las preguntas de apertura/cierre siguen siendo horario comercial", async () => {
    await expect(wantsAvailability("¿A qué hora abren el viernes?")).resolves.toBe(false);
    await expect(wantsAvailability("¿Abren el viernes?")).resolves.toBe(false);
    await expect(
      wantsAvailability("¿Cuál es su horario de atención el viernes?")
    ).resolves.toBe(false);
    await expect(
      wantsAvailability("¿Hasta qué hora atienden el viernes?")
    ).resolves.toBe(false);
    await expect(wantsAvailability("¿Están abiertos el viernes?")).resolves.toBe(false);
  });

  it("una cita explícita tampoco se confunde con horario comercial", async () => {
    await expect(wantsAvailability("quiero una cita el viernes")).resolves.toBe(true);
    await expect(
      wantsAvailability("¿tienen disponibilidad el viernes?")
    ).resolves.toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AG-HOLA — el turno actual justifica la agenda
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-09-15T05:00:00.000Z");
const DAY1 = "2026-09-16";

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

let offers: OfferedSlot[] = [];
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
  return { ...original, getOffers: async () => offers, replaceOffers: async () => {} };
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
  (chain as { then: unknown }).then = (res: (v: unknown) => void) =>
    Promise.resolve(rows).then(res);
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
          onConflictDoUpdate: () => chain,
          returning: () => Promise.resolve([values]),
          then: (resolve: (v: unknown) => void) => Promise.resolve([values]).then(resolve),
        };
        return chain;
      },
    }),
    delete: () => ({ where: () => Promise.resolve([]) }),
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

const CONVERSACION = {
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

/**
 * Historial previo de agenda: el saliente es ANTERIOR al inbound del turno, que
 * es lo que hace `repeatedGreeting = true`. Se construye en cada test para que
 * los tiempos se calculen con el reloj falso ya fijado.
 */
function historialAgenda() {
  const t = Date.now();
  return [
    {
      id: "m2",
      direction: "out",
      text: "Tengo estos horarios:\n• 09:00",
      createdAt: new Date(t - 60_000),
    },
    {
      id: "m1",
      direction: "in",
      text: "quiero una cita",
      createdAt: new Date(t - 120_000),
    },
  ];
}

function queueTurno(history: unknown[]) {
  selectQueue.push([CONVERSACION], [PERFIL], history, [], []);
}

function ultimoTextoSaliente(): string {
  const salida = [...inserts]
    .reverse()
    .find((i) => (i.values as { direction?: string }).direction === "out");
  return (salida?.values as { text?: string })?.text ?? "";
}

/** El bloque de huecos que ve el modelo (si se inyectó). */
function mapaEnviadoAlModelo(): string | null {
  const call = chatJson.mock.calls.at(-1);
  const messages = call?.[1] as { role: string; content: string }[] | undefined;
  return (
    messages?.find(
      (m) => m.role === "system" && m.content.includes("Horarios vigentes")
    )?.content ?? null
  );
}

describe("AG-HOLA — un turno neutral no recibe contexto de agenda", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    selectQueue.length = 0;
    inserts.length = 0;
    offers = [];
    chatJson.mockReset();
    computeAvailability.mockReset();
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("AGENDA", "on");
  });

  afterEach(() => vi.useRealTimers());

  it("historial de agenda + 'Hola' → NO se inyecta el catálogo ni se consulta disponibilidad", async () => {
    offers = [{ startUtc: `${DAY1}T15:00:00.000Z`, label: "viejo" }];
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { action: "reply", text: "¡Hola! ¿En qué te ayudo?" },
    });
    queueTurno([
      { id: "m3", direction: "in", text: "Hola", createdAt: new Date() },
      ...historialAgenda(),
    ]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(mapaEnviadoAlModelo()).toBeNull();
    expect(computeAvailability).not.toHaveBeenCalled();
    expect(ultimoTextoSaliente()).toContain("Hola");
  });

  it("historial de agenda + 'Gracias' → tampoco", async () => {
    offers = [{ startUtc: `${DAY1}T15:00:00.000Z`, label: "viejo" }];
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { action: "reply", text: "¡Con gusto!" },
    });
    queueTurno([
      { id: "m3", direction: "in", text: "Gracias", createdAt: new Date() },
      ...historialAgenda(),
    ]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(mapaEnviadoAlModelo()).toBeNull();
    expect(computeAvailability).not.toHaveBeenCalled();
  });

  it("historial de agenda + 'otros horarios' → SÍ lleva el catálogo", async () => {
    offers = [{ startUtc: `${DAY1}T15:00:00.000Z`, label: "viejo" }];
    computeAvailability.mockResolvedValue([
      { startUtc: `${DAY1}T15:00:00.000Z`, endUtc: `${DAY1}T15:30:00.000Z` },
      { startUtc: "2026-09-17T15:00:00.000Z", endUtc: "2026-09-17T15:30:00.000Z" },
    ]);
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { action: "reply", text: "..." },
    });
    queueTurno([
      { id: "m3", direction: "in", text: "otros horarios", createdAt: new Date() },
      ...historialAgenda(),
    ]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(mapaEnviadoAlModelo()).not.toBeNull();
    expect(ultimoTextoSaliente()).toContain("Otro día tengo:");
  });

  it("historial de agenda + '10:20' → el catálogo llega y NO se reserva", async () => {
    const startUtc = `${DAY1}T15:00:00.000Z`;
    offers = [{ startUtc, label: "viejo" }];
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { action: "book_slot", startUtc, reply: "¡Listo!" },
    });
    queueTurno([
      { id: "m3", direction: "in", text: "10:20", createdAt: new Date() },
      ...historialAgenda(),
    ]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(mapaEnviadoAlModelo()).not.toBeNull();
    expect(ultimoTextoSaliente()).toContain("¿Quieres que agende tu cita?");
    expect(ultimoTextoSaliente()).not.toContain("Te agendé");
  });

  it("historial de agenda + 'la primera' → el catálogo llega y NO se reserva", async () => {
    const startUtc = `${DAY1}T15:00:00.000Z`;
    offers = [{ startUtc, label: "viejo" }];
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { action: "book_slot", startUtc, reply: "¡Listo!" },
    });
    queueTurno([
      { id: "m3", direction: "in", text: "la primera", createdAt: new Date() },
      ...historialAgenda(),
    ]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(mapaEnviadoAlModelo()).not.toBeNull();
    expect(ultimoTextoSaliente()).toContain("¿Quieres que agende tu cita?");
    expect(ultimoTextoSaliente()).not.toContain("Te agendé");
  });

  it("conversación nueva + 'Hola' → saludo normal, sin agenda", async () => {
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { action: "reply", text: "¡Hola! ¿En qué te ayudo?" },
    });
    queueTurno([
      { id: "m1", direction: "in", text: "Hola", createdAt: new Date() },
    ]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(mapaEnviadoAlModelo()).toBeNull();
    expect(computeAvailability).not.toHaveBeenCalled();
    expect(ultimoTextoSaliente()).toContain("Hola");
  });

  it("el prompt instruye que un saludo neutral no es señal de agenda", async () => {
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { action: "reply", text: "¡Hola!" },
    });
    queueTurno([
      { id: "m2", direction: "in", text: "Hola", createdAt: new Date() },
      ...historialAgenda(),
    ]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const call = chatJson.mock.calls.at(-1);
    const messages = call?.[1] as { role: string; content: string }[];
    const system = messages.find((m) => m.role === "system")!.content;
    expect(system).toContain("NO es señal de agenda");
    expect(system).toContain("NO lo retomes");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QB-01 / QB-07 — contratos del diálogo manual
// ─────────────────────────────────────────────────────────────────────────────

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("QB-07 — el diálogo manual permite elegir otro día", () => {
  const dialog = source("src/components/inbox/quick-booking-dialog.tsx");

  it("consulta por rango de un día y no vuelca la semana", () => {
    expect(dialog).toContain('params.set("from", day)');
    expect(dialog).toContain('params.set("to", day)');
    expect(dialog).toContain("shiftIsoDay");
  });

  it("ofrece navegación anterior/siguiente y avisa cuando el día no tiene huecos", () => {
    expect(dialog).toContain("Día anterior");
    expect(dialog).toContain("Día siguiente");
    expect(dialog).toContain("Sin disponibilidad este día.");
    expect(dialog).toContain("Buscar el siguiente día disponible");
    expect(dialog).toContain("No encontré más días con disponibilidad");
  });

  it("mantiene el fallback de cita general y el tope de 12 inicial", () => {
    expect(dialog).toContain("Cita general");
    expect(dialog).toContain("data.slots.slice(0, 12)");
  });
});

describe("QB-01 — el 409 de hueco ocupado es visible", () => {
  const dialog = source("src/components/inbox/quick-booking-dialog.tsx");

  it("un conflicto explica qué pasó y no se borra al refrescar", () => {
    expect(dialog).toContain("Ese horario acaba de ocuparse. Elige otro.");
    expect(dialog).toContain("actionError");
    // El refresco posterior NO puede limpiar el error de acción.
    expect(dialog).not.toContain("setActionError(null);\n\n    const params");
  });

  it("refresca los huecos después del conflicto", () => {
    expect(dialog).toContain("void refreshSlots()");
  });
});
