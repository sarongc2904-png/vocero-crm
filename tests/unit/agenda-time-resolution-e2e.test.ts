import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveExpandRequest } from "@/server/agenda/expand";
import type { OfferedSlot } from "@/server/agenda/offers";

/**
 * Caso real del negocio "prueba" (L-V 09:00-18:00, citas de 30 min, 0 de
 * respiro, aviso mínimo 2 h, America/Mexico_City), 2026-10-05 22:43 local:
 *
 *   Cliente: "Por la tarde"   → se ofrecían solo 12:00, 12:30, 13:00, 13:30.
 *   Cliente: "4"              → el modelo repetía la lista.
 *   Cliente: "4 de la tarde"  → se ofrecían los mismos cuatro del miércoles,
 *                               aunque el martes a las 16:00 estaba libre.
 *
 * Toda hora que dice el cliente se resuelve contra TODA la disponibilidad del
 * día mostrado (no solo los horarios visibles) y de forma determinista, antes
 * del modelo. Un número suelto con una lista mostrada es ambiguo: se pregunta.
 */

const TZ = "America/Mexico_City";
const TUE = "2026-10-06";
const WED = "2026-10-07";
const SHOWN_AT = new Date("2026-10-06T04:43:33.000Z");
const RECEIVED_AT = new Date("2026-10-06T04:43:43.000Z");

function at(day: string, time: string): string {
  return new Date(`${day}T${time}:00-06:00`).toISOString();
}

function minutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h! * 60 + m!;
}

function hhmm(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function freeDay(day: string, taken: string[] = []) {
  const out: { startUtc: string; endUtc: string; label: string }[] = [];
  for (let m = 9 * 60; m < 18 * 60; m += 30) {
    if (taken.includes(hhmm(m))) continue;
    const startUtc = at(day, hhmm(m));
    out.push({
      startUtc,
      endUtc: new Date(Date.parse(startUtc) + 30 * 60_000).toISOString(),
      label: `${day} ${hhmm(m)}`,
    });
  }
  return out;
}

/** El mensaje real que vio el cliente (formato anterior). */
const SHOWN_AFTERNOON = [
  "Para la tarde tengo:",
  "Mañana martes, 6 de octubre",
  "• 12:00",
  "• 12:30",
  "• 13:00",
  "• 13:30",
  "¿Cuál le funciona mejor?",
].join("\n");

const SHOWN_BASE = [
  "Tengo estos horarios disponibles:",
  "Mañana martes, 6 de octubre",
  "• 09:00",
  "• 09:30",
  "• 10:00",
  "• 10:30",
  "¿Cuál le funciona mejor?",
].join("\n");

const settings = {
  weeklyHours: {
    mon: [{ start: "09:00", end: "18:00" }],
    tue: [{ start: "09:00", end: "18:00" }],
    wed: [{ start: "09:00", end: "18:00" }],
    thu: [{ start: "09:00", end: "18:00" }],
    fri: [{ start: "09:00", end: "18:00" }],
  },
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 2,
  maxDaysAhead: 14,
  timezone: TZ,
  connector: "google" as const,
  meetingLink: null,
};

let offers: OfferedSlot[] = [];
let freeByDay: Record<string, ReturnType<typeof freeDay>> = {};
const computeAvailability = vi.fn(
  async (_org: string, opts?: { fromISO?: string; toISO?: string }) => {
    if (opts?.fromISO && opts.toISO) {
      return Object.entries(freeByDay)
        .filter(([day]) => day >= opts.fromISO! && day <= opts.toISO!)
        .flatMap(([, slots]) => slots);
    }
    return Object.values(freeByDay).flat();
  }
);
const findSlot = vi.fn(async (_org: string, whenISO: string) => {
  const hit = Object.values(freeByDay)
    .flat()
    .find((slot) => slot.startUtc === new Date(whenISO).toISOString());
  return hit ?? null;
});
const replaceOffers = vi.fn(async (_org: string, _conv: string, slots: OfferedSlot[]) => {
  offers = slots;
});
const createSessionBooking = vi.fn();
const chatJson = vi.fn();

vi.mock("@/lib/ai", () => ({ chatJson: (...args: unknown[]) => chatJson(...args) }));
vi.mock("@/server/agenda/settings", () => ({ getSettings: async () => settings }));
vi.mock("@/server/agenda/availability", () => ({
  computeAvailability: (...args: unknown[]) =>
    computeAvailability(...(args as [string, { fromISO?: string; toISO?: string } | undefined])),
  findSlot: (...args: unknown[]) => findSlot(...(args as [string, string])),
}));
vi.mock("@/server/agenda/professional-availability", () => ({
  findProfessionalSlot: vi.fn(),
}));
vi.mock("@/server/agenda/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/service")>();
  return {
    ...original,
    createSessionBooking: (...args: unknown[]) => createSessionBooking(...args),
  };
});
vi.mock("@/server/agenda/offers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/offers")>();
  return {
    ...original,
    getOffers: async () => offers,
    replaceOffers: (...args: unknown[]) =>
      replaceOffers(...(args as [string, string, OfferedSlot[]])),
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
  for (const m of ["from", "innerJoin", "leftJoin", "where", "orderBy", "limit"]) chain[m] = () => chain;
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(rows).then(resolve);
  return chain;
}

vi.mock("@/server/ai/observability", () => ({
  createAgentRun: async (input: { organizationId: string; conversationId: string }) => ({
    runId: "test-agent-run",
    organizationId: input.organizationId,
    conversationId: input.conversationId,
  }),
  finishAgentRun: async () => {},
  hasActiveAgentRun: () => true,
  recordAgentAction: async () => {},
  recordAgentEvidence: async () => {},
  withAgentRun: async <T>(_context: unknown, fn: () => Promise<T>): Promise<T> => fn(),
}));

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

const CONVERSATION = {
  id: "cv_prueba",
  organizationId: "org_1",
  contactId: "ct_1",
  isTest: true,
  aiEnabled: true,
  handoffAt: null,
  handoffReason: null,
  lastInboundAt: new Date(),
};

const PROFILE = {
  id: "agp_1",
  organizationId: "org_1",
  enabled: true,
  name: "Agente",
  tone: null,
  instructions: null,
  escalationRules: null,
  greeting: null,
};

function catalog(days: Record<string, ReturnType<typeof freeDay>>): OfferedSlot[] {
  return Object.values(days)
    .flat()
    .map((slot) => ({ startUtc: slot.startUtc, label: slot.label }));
}

function queueTurn(shownText: string, inbound: string) {
  selectQueue.push(
    [CONVERSATION],
    [PROFILE],
    [
      { id: "m0", direction: "out", text: shownText, createdAt: SHOWN_AT },
      { id: "m1", direction: "in", text: inbound, createdAt: RECEIVED_AT },
    ],
    [],
    []
  );
}

function lastOutbound(): string {
  const out = [...inserts]
    .reverse()
    .find((entry) => (entry.values as { direction?: string }).direction === "out");
  return (out?.values as { text?: string })?.text ?? "";
}

function pendingBook(): Record<string, unknown> | undefined {
  return inserts.find((entry) => entry.values.action === "book")?.values;
}

function timesIn(text: string): string[] {
  return [...text.matchAll(/(?:^|\s)(\d{2}:\d{2})(?=\s|$|[),.?])/gm)].map((m) => m[1]!);
}

async function turn(shownText: string, inbound: string) {
  queueTurn(shownText, inbound);
  const { runAgentTurn } = await import("@/server/ai/pipeline");
  await runAgentTurn("cv_prueba");
}

// El primer import del pipeline carga todo el agente (varios segundos bajo
// carga): se hace una vez aquí y no dentro del tiempo de cada prueba.
beforeAll(async () => {
  await import("@/server/ai/pipeline");
}, 60_000);

function resetAll(days: Record<string, ReturnType<typeof freeDay>>) {
  selectQueue.length = 0;
  inserts.length = 0;
  freeByDay = days;
  offers = catalog(days);
  chatJson.mockReset();
  chatJson.mockResolvedValue({ ok: true, data: { action: "reply", text: "respuesta del modelo" } });
  computeAvailability.mockClear();
  findSlot.mockClear();
  replaceOffers.mockClear();
  createSessionBooking.mockReset();
}

describe("regla 4: un número antes de 'de la tarde' es una hora, no una ampliación", () => {
  it.each(["4 de la tarde", "las 4 de la tarde", "4:30 de la tarde", "10 de la mañana"])(
    "%s no se clasifica como ampliación",
    (text) => {
      expect(resolveExpandRequest(text)).toBeNull();
    }
  );

  it("'por la tarde' y 'por la mañana' siguen siendo preferencia de bloque", () => {
    expect(resolveExpandRequest("Por la tarde")).toBe("afternoon");
    expect(resolveExpandRequest("por la mañana")).toBe("morning");
  });

  it("'más tarde' es distinto de 'por la tarde': pide horarios posteriores", () => {
    expect(resolveExpandRequest("más tarde")).toBe("later");
  });
});

describe("caso real del negocio 'prueba' (pipeline)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(RECEIVED_AT);
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("AGENDA", "on");
    resetAll({ [TUE]: freeDay(TUE), [WED]: freeDay(WED) });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("'Por la tarde' reparte la tarde del martes en vez de los cuatro primeros", async () => {
    await turn(SHOWN_BASE, "Por la tarde");
    const text = lastOutbound();
    const times = timesIn(text);
    expect(text).toContain("6 de octubre");
    expect(text).not.toContain("7 de octubre");
    expect(times.length).toBeGreaterThanOrEqual(2);
    expect(times.every((t) => minutes(t) >= 12 * 60)).toBe(true);
    expect(times).toContain("17:30");
    expect(times).not.toEqual(["12:00", "12:30", "13:00", "13:30"]);
  });

  it("'Por la mañana' reparte la mañana del martes", async () => {
    await turn(SHOWN_AFTERNOON, "Por la mañana");
    const times = timesIn(lastOutbound());
    expect(times.every((t) => minutes(t) < 12 * 60)).toBe(true);
    expect(times).toContain("09:00");
    expect(times).toContain("11:30");
    expect(lastOutbound()).toContain("6 de octubre");
  });

  it("'4' con una lista mostrada es ambiguo: pregunta, sin modelo ni reserva", async () => {
    await turn(SHOWN_AFTERNOON, "4");
    expect(chatJson).not.toHaveBeenCalled();
    const text = lastOutbound();
    expect(text).toContain("16:00");
    expect(text).toMatch(/opción 4/i);
    expect(text).toContain("13:30");
    expect(pendingBook()).toBeUndefined();
    expect(createSessionBooking).not.toHaveBeenCalled();
  });

  it.each([
    ["4 de la tarde", "16:00"],
    ["a las 4", "16:00"],
    ["a las 4 pm", "16:00"],
    ["4 pm", "16:00"],
    ["16:00", "16:00"],
    ["4:30", "16:30"],
    ["a las 4 y media", "16:30"],
    ["4:30 de la tarde", "16:30"],
  ])("'%s' se resuelve contra todo el martes → %s (confirmación, sin reservar)", async (text, time) => {
    await turn(SHOWN_AFTERNOON, text);
    expect(chatJson).not.toHaveBeenCalled();
    expect(lastOutbound()).toBe(
      `Perfecto. Tengo martes 6 a las ${time} disponible. ¿Quiere que agende su cita?`
    );
    const pending = pendingBook();
    expect(pending).toBeDefined();
    expect((pending!.startUtc as Date).toISOString()).toBe(at(TUE, time));
    expect(createSessionBooking).not.toHaveBeenCalled();
  });

  it.each([
    ["la cuarta", "13:30"],
    ["la última", "13:30"],
  ])("'%s' sigue refiriéndose a la lista mostrada (%s)", async (text, time) => {
    await turn(SHOWN_AFTERNOON, text);
    expect(lastOutbound()).toBe(
      `Perfecto. Tengo martes 6 a las ${time} disponible. ¿Quiere que agende su cita?`
    );
    expect((pendingBook()!.startUtc as Date).toISOString()).toBe(at(TUE, time));
  });

  it("hora ocupada: lo dice y ofrece los huecos libres más cercanos del mismo día", async () => {
    resetAll({ [TUE]: freeDay(TUE, ["16:00"]), [WED]: freeDay(WED) });
    await turn(SHOWN_AFTERNOON, "4 de la tarde");
    expect(chatJson).not.toHaveBeenCalled();
    const text = lastOutbound();
    expect(text).toMatch(/16:00.*no (?:está|están) disponible/i);
    expect(text).toContain("15:30");
    expect(text).toContain("16:30");
    expect(text).not.toContain("7 de octubre");
    expect(pendingBook()).toBeUndefined();
  });

  it.each([
    ["a las 8 de la noche", "17:30"],
    ["20:00", "17:30"],
    ["a las 7 de la mañana", "09:00"],
  ])("'%s' fuera de horario: lo dice y ofrece lo más cercano (%s)", async (text, nearest) => {
    await turn(SHOWN_AFTERNOON, text);
    expect(chatJson).not.toHaveBeenCalled();
    const out = lastOutbound();
    expect(out).toMatch(/fuera del horario de atención/i);
    expect(out).toContain(nearest);
    expect(pendingBook()).toBeUndefined();
  });

  it("'más tarde' tras 12:00-13:30 ofrece horarios posteriores del mismo martes", async () => {
    await turn(SHOWN_AFTERNOON, "más tarde");
    const times = timesIn(lastOutbound());
    expect(times.length).toBeGreaterThan(0);
    expect(times.every((t) => minutes(t) > minutes("13:30"))).toBe(true);
    expect(lastOutbound()).toContain("6 de octubre");
    expect(lastOutbound()).not.toContain("7 de octubre");
  });

  it("'otro día' pasa al miércoles y lo presenta en mañana y tarde", async () => {
    await turn(SHOWN_AFTERNOON, "otro día");
    const text = lastOutbound();
    expect(text).toContain("7 de octubre");
    expect(text).toContain("Mañana:");
    expect(text).toContain("Tarde:");
  });
});

/**
 * Barrido de horas habladas contra todo el martes: libres, ocupadas y fuera
 * de horario. Cada rama debe ejercitarse; cada iteración valida su contrato.
 */
describe("barrido de horas contra la disponibilidad completa del día", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(RECEIVED_AT);
    vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
    vi.stubEnv("AGENDA", "on");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("libre → confirma esa hora; ocupada → cercanas libres; fuera → aviso", async () => {
    const taken = ["10:00", "13:00", "15:30", "16:00", "17:30"];
    const branches = { free: 0, taken: 0, outside: 0 };
    for (let m = 7 * 60; m <= 20 * 60; m += 30) {
      resetAll({ [TUE]: freeDay(TUE, taken), [WED]: freeDay(WED) });
      const time = hhmm(m);
      await turn(SHOWN_AFTERNOON, time);
      expect(chatJson, time).not.toHaveBeenCalled();
      const out = lastOutbound();
      const inHours = m >= 9 * 60 && m < 18 * 60;
      if (inHours && !taken.includes(time)) {
        branches.free += 1;
        expect(out, time).toBe(
          `Perfecto. Tengo martes 6 a las ${time} disponible. ¿Quiere que agende su cita?`
        );
        expect((pendingBook()!.startUtc as Date).toISOString(), time).toBe(at(TUE, time));
      } else {
        expect(pendingBook(), time).toBeUndefined();
        if (inHours) {
          branches.taken += 1;
          expect(out, time).toMatch(/no (?:está|están) disponible/i);
        } else {
          branches.outside += 1;
          expect(out, time).toMatch(/fuera del horario de atención/i);
        }
        // Las sugerencias son las líneas con viñeta (el horario de atención
        // también aparece en el aviso, pero no es una sugerencia).
        const suggested = [...out.matchAll(/^• (\d{2}:\d{2})$/gm)].map((m) => m[1]!);
        expect(suggested.length, time).toBeGreaterThan(0);
        for (const t of suggested) {
          expect(taken, `${time} sugiere ${t}`).not.toContain(t);
          expect(minutes(t) >= 9 * 60 && minutes(t) < 18 * 60, `${time} sugiere ${t}`).toBe(true);
        }
      }
    }
    expect(branches.free).toBeGreaterThan(0);
    expect(branches.taken).toBeGreaterThan(0);
    expect(branches.outside).toBeGreaterThan(0);
  }, 60_000); // 27 turnos completos del pipeline
});
