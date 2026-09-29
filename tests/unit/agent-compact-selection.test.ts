import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveExpandRequest } from "@/server/agenda/expand";
import { isBareTimeSelection } from "@/server/agenda/selection";
import type { OfferedSlot } from "@/server/agenda/offers";

/**
 * 015 — Ampliación y selección de horario en la conversación de agenda.
 *
 *  - `resolveExpandRequest` clasifica los follow-ups compactos (otro día,
 *    más tarde, por la tarde, fin de semana) de forma determinista.
 *  - `isBareTimeSelection` distingue "mencionar una hora" de "confirmar
 *    agendar": seleccionar ≠ reservar.
 *  - A nivel de pipeline, un `book_slot` sobre una selección desnuda se
 *    convierte en confirmación; no se crea la cita todavía.
 */

const NOW = new Date("2026-09-15T05:00:00.000Z");
const DAY1 = "2026-09-16";
const DAY2 = "2026-09-17";

describe("resolveExpandRequest", () => {
  it("clasifica los follow-ups compactos", () => {
    expect(resolveExpandRequest("otros horarios")).toBe("next_day");
    expect(resolveExpandRequest("otro día")).toBe("next_day");
    expect(resolveExpandRequest("otra hora")).toBe("next_day");
    expect(resolveExpandRequest("más tarde")).toBe("afternoon");
    expect(resolveExpandRequest("por la tarde")).toBe("afternoon");
    expect(resolveExpandRequest("en la mañana")).toBe("morning");
    expect(resolveExpandRequest("fin de semana")).toBe("weekend");
    expect(resolveExpandRequest("finde")).toBe("weekend");
  });

  it("no confunde fecha única ni texto suelto", () => {
    expect(resolveExpandRequest("mañana")).toBeNull(); // mañana = fecha, no daypart
    expect(resolveExpandRequest("sábado")).toBeNull();
    expect(resolveExpandRequest("el viernes")).toBeNull();
    expect(resolveExpandRequest("¿cuánto cuesta?")).toBeNull();
  });
});

describe("isBareTimeSelection", () => {
  it("una hora sola es selección desnuda (aún no reserva)", () => {
    expect(isBareTimeSelection("10:20")).toBe(true);
    expect(isBareTimeSelection("el de las 11")).toBe(true);
    expect(isBareTimeSelection("la primera")).toBe(true);
    expect(isBareTimeSelection("el de 11")).toBe(true);
  });

  it("una confirmación explícita NO es selección desnuda", () => {
    expect(isBareTimeSelection("quiero el primero")).toBe(false);
    expect(isBareTimeSelection("sí, agéndalo")).toBe(false);
    expect(isBareTimeSelection("10:20 me sirve")).toBe(false);
    expect(isBareTimeSelection("agenda la primera")).toBe(false);
    expect(isBareTimeSelection("perfecto, dale")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline: ampliación y guardarraíl de selección (mismo harness que los e2e).
// ─────────────────────────────────────────────────────────────────────────────

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
  return {
    ...original,
    getOffers: async () => offers,
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

describe("pipeline — ampliación y selección compacta", () => {
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("'más tarde' tras una oferta muestra la tarde, no vuelca toda la agenda", async () => {
    computeAvailability.mockImplementation(async () => [
      { startUtc: `${DAY1}T09:00:00.000Z`, endUtc: `${DAY1}T09:30:00.000Z` },
      { startUtc: `${DAY1}T10:00:00.000Z`, endUtc: `${DAY1}T10:30:00.000Z` },
      { startUtc: `${DAY1}T13:00:00.000Z`, endUtc: `${DAY1}T13:30:00.000Z` },
      { startUtc: `${DAY1}T14:00:00.000Z`, endUtc: `${DAY1}T14:30:00.000Z` },
      { startUtc: `${DAY2}T15:00:00.000Z`, endUtc: `${DAY2}T15:30:00.000Z` },
    ]);
    chatJson.mockResolvedValueOnce({ ok: true, data: { action: "reply", text: "..." } });
    queueTurno([{ id: "m1", direction: "in", text: "más tarde", createdAt: new Date() }]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const texto = ultimoTextoSaliente();
    expect(texto).toContain("Para la tarde tengo:");
    expect(texto).toContain("13:00");
    expect(texto).not.toContain("09:00"); // la mañana no se repite
  });

  it("'10:20' (selección sin confirmar) NO reserva: confirma y pregunta", async () => {
    const startUtc = `${DAY1}T15:00:00.000Z`;
    offers = [{ startUtc, label: "viejo" }];
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { action: "book_slot", startUtc, reply: "¡Listo!" },
    });
    queueTurno([{ id: "m1", direction: "in", text: "10:20", createdAt: new Date() }]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const texto = ultimoTextoSaliente();
    expect(texto).toContain("¿Quieres que agende tu cita?");
    expect(texto).not.toContain("Te agendé"); // NO se creó la cita
  });

  it("'la primera' (selección ordinal) confirma el primer horario sin reservar", async () => {
    const first = `${DAY1}T15:00:00.000Z`;
    offers = [
      { startUtc: first, label: "viejo" },
      { startUtc: `${DAY1}T16:00:00.000Z`, label: "viejo" },
    ];
    chatJson.mockResolvedValueOnce({
      ok: true,
      data: { action: "book_slot", startUtc: first, reply: "¡Listo!" },
    });
    queueTurno([{ id: "m1", direction: "in", text: "la primera", createdAt: new Date() }]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    const texto = ultimoTextoSaliente();
    expect(texto).toContain("¿Quieres que agende tu cita?");
    expect(texto).not.toContain("Te agendé");
  });
});
