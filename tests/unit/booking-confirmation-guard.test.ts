import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OfferedSlot } from "@/server/agenda/offers";

/**
 * Guardia de confirmación de citas (pipeline real, modelo simulado).
 *
 * Regla: ninguna cita se crea, mueve ni cancela sin una acción pendiente
 * vigente Y una confirmación explícita del cliente en ese turno. Las acciones
 * `book_slot`, `reschedule_slot` y `cancel_booking` del modelo solo pueden
 * DEJAR una acción pendiente y preguntar; ejecutar es exclusivo del bloque que
 * consume la pendiente.
 *
 * El almacén de pendientes se simula en memoria con la misma semántica que la
 * tabla: una fila por conversación, expiración, y `consumePendingAction`
 * atómico (lee y borra en un solo paso, como el DELETE … RETURNING real).
 */

const TZ = "America/Mexico_City";
const TUE = "2026-10-06";
const SHOWN_AT = new Date("2026-10-06T04:43:33.000Z");
const NOW = new Date("2026-10-06T04:43:43.000Z");

function at(day: string, time: string): string {
  return new Date(`${day}T${time}:00-06:00`).toISOString();
}

const settings = {
  weeklyHours: { tue: [{ start: "09:00", end: "18:00" }] },
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 2,
  maxDaysAhead: 14,
  timezone: TZ,
  connector: "google" as const,
  meetingLink: null,
};

type Pending = {
  id: string;
  action: "book" | "reschedule" | "cancel";
  bookingId: string | null;
  startUtc: string | null;
  serviceId: string | null;
  professionalId: string | null;
  expiresAt: Date;
};

const store = vi.hoisted(() => ({
  pending: null as null | {
    id: string;
    action: "book" | "reschedule" | "cancel";
    bookingId: string | null;
    startUtc: string | null;
    serviceId: string | null;
    professionalId: string | null;
    expiresAt: Date;
  },
}));

let offers: OfferedSlot[] = [];
const createSessionBooking = vi.fn();
const rescheduleForConversation = vi.fn();
const cancelBookingForConversation = vi.fn();
const chatJson = vi.fn();

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const live = () =>
  store.pending && store.pending.expiresAt.getTime() > Date.now() ? store.pending : null;

vi.mock("@/server/agenda/pending-actions", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/pending-actions")>();
  return {
    ...original,
    setPendingAction: async (input: {
      action: "book" | "reschedule" | "cancel";
      bookingId?: string | null;
      startUtc?: string | null;
      serviceId?: string | null;
      professionalId?: string | null;
    }) => {
      await tick();
      store.pending = {
        id: "paa_1",
        action: input.action,
        bookingId: input.bookingId ?? null,
        startUtc: input.startUtc ? new Date(input.startUtc).toISOString() : null,
        serviceId: input.serviceId ?? null,
        professionalId: input.professionalId ?? null,
        expiresAt: new Date(Date.now() + original.PENDING_TTL_MS),
      };
    },
    getPendingAction: async () => {
      await tick();
      return live();
    },
    peekPendingAction: async () => live(),
    clearPendingAction: async () => {
      await tick();
      store.pending = null;
    },
    // Atómico: tomar y borrar ocurre sin ceder el control. Como el DELETE de la
    // BD simulada no filtra, devuelve la fila TAL CUAL (aunque haya vencido) y
    // decide la comprobación real del módulo (`executablePending`).
    consumePendingAction: async () => {
      const row = store.pending;
      store.pending = null;
      await tick();
      return original.executablePending(
        row
          ? {
              ...row,
              organizationId: "org_1",
              conversationId: "cv_1",
              startUtc: row.startUtc ? new Date(row.startUtc) : null,
              createdAt: new Date(row.expiresAt.getTime() - original.PENDING_TTL_MS),
            }
          : undefined,
        new Date()
      );
    },
  };
});

vi.mock("@/lib/ai", () => ({ chatJson: (...args: unknown[]) => chatJson(...args) }));
vi.mock("@/server/agenda/settings", () => ({ getSettings: async () => settings }));
vi.mock("@/server/agenda/availability", () => ({
  computeAvailability: async () =>
    offers.map((o) => ({ startUtc: o.startUtc, endUtc: o.startUtc, label: o.label })),
  findSlot: async (_org: string, iso: string) =>
    offers.find((o) => o.startUtc === new Date(iso).toISOString()) ?? null,
}));
vi.mock("@/server/agenda/professional-availability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/agenda/professional-availability")>()),
  findProfessionalSlot: async (_org: string, input: { startUtc: string }) =>
    offers.find((o) => o.startUtc === input.startUtc) ?? null,
}));
vi.mock("@/server/agenda/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/agenda/service")>()),
  createSessionBooking: (...args: unknown[]) => createSessionBooking(...args),
  rescheduleForConversation: (...args: unknown[]) => rescheduleForConversation(...args),
  cancelBookingForConversation: (...args: unknown[]) => cancelBookingForConversation(...args),
}));
vi.mock("@/server/agenda/offers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/agenda/offers")>()),
  getOffers: async () => offers,
  replaceOffers: async (_org: string, _conv: string, slots: OfferedSlot[]) => {
    offers = slots;
  },
  clearOffers: async () => {
    offers = [];
  },
}));
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  graphRequest: vi.fn(),
}));
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

/** Filas por tabla: la conversación, el perfil y el historial del turno. */
const rowsByTable: Record<string, unknown[]> = {};
const outbound: string[] = [];
/** Salientes que se intentaron guardar/enviar (aunque el envío falle). */
const attemptedOutbound: string[] = [];
/** `set` de cada UPDATE: el handoff se ve como `handoffAt` + `aiEnabled: false`. */
const updates: Record<string, unknown>[] = [];
/** Simula que el envío de un saliente falla (error de red o de la BD). */
const sendFailure = { on: false };

function thenableChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["innerJoin", "leftJoin", "where", "orderBy", "limit"]) {
    chain[m] = () => chain;
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
    Promise.resolve(rows).then(resolve);
  return chain;
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: (table: { __table?: string }) =>
        thenableChain([...(rowsByTable[table.__table ?? ""] ?? [])]),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        if (values.direction === "out" && typeof values.text === "string") {
          attemptedOutbound.push(values.text);
          if (sendFailure.on) throw new Error("envío simulado fallido");
          outbound.push(values.text);
        }
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
      set: (values: Record<string, unknown>) => (updates.push(values), {
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
        new Proxy(
          {},
          {
            get: (_t2, col) =>
              col === "__table" ? String(tableName) : `${String(tableName)}.${String(col)}`,
          }
        ),
    }
  ),
}));

const CONVERSATION = {
  id: "cv_1",
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

const SHOWN = [
  "Tengo estos horarios disponibles:",
  "Mañana martes, 6 de octubre",
  "• 12:00",
  "• 13:00",
  "• 14:00",
  "• 16:00",
  "¿Cuál le funciona mejor?",
].join("\n");

const PROPOSAL = "Perfecto. Tengo martes 6 a las 16:00 disponible. ¿Quiere que agende su cita?";

function catalog(withService = false): OfferedSlot[] {
  return ["12:00", "13:00", "14:00", "16:00"].map((time) => ({
    startUtc: at(TUE, time),
    label: `martes 6 a las ${time}`,
    ...(withService ? { serviceId: "svc_corte", professionalId: "pro_ana" } : {}),
  }));
}

type Msg = { direction: "in" | "out"; text: string; createdAt: Date };

/** El historial en orden cronológico; la BD lo entrega del más nuevo al más viejo. */
/** La cita activa del cliente: cancelar y reprogramar se confirman sobre ella. */
const BOOKING = {
  id: "bk_1",
  organizationId: "org_1",
  contactId: "ct_1",
  conversationId: "cv_1",
  kind: "session",
  status: "agendada",
  scheduledAt: new Date(at("2026-10-08", "10:00")),
  timezone: TZ,
};

function setHistory(history: Msg[]) {
  rowsByTable.conversation = [CONVERSATION];
  rowsByTable.agentProfile = [PROFILE];
  rowsByTable.booking = [BOOKING];
  rowsByTable.message = history.map((m, i) => ({ id: `m${i}`, ...m })).reverse();
}

async function turn(history: Msg[]) {
  outbound.length = 0;
  setHistory(history);
  const { runAgentTurn } = await import("@/server/ai/pipeline");
  await runAgentTurn("cv_1", "org_1");
}

function lastOut(): string {
  return outbound.at(-1) ?? "";
}

function model(data: Record<string, unknown>) {
  chatJson.mockReset();
  chatJson.mockResolvedValue({ ok: true, data });
}

function setPending(
  action: Pending["action"],
  startTime: string | null,
  extra: Partial<Pending> = {},
  minutesLeft = 30
) {
  store.pending = {
    id: "paa_1",
    action,
    // Cancelar y reprogramar guardan la cita exacta sobre la que se confirma.
    bookingId: action === "book" ? null : BOOKING.id,
    startUtc: startTime ? at(TUE, startTime) : null,
    serviceId: null,
    professionalId: null,
    expiresAt: new Date(Date.now() + minutesLeft * 60_000),
    ...extra,
  };
}

const currentPending = (): Pending | null => store.pending;

const okBooking = (input: { startUtc: string }) => ({
  booking: { durationMinutes: 30 },
  label: `martes 6 a las ${new Date(input.startUtc).toISOString()}`,
  meetingLink: null,
  linkPending: false,
});

beforeAll(async () => {
  await import("@/server/ai/pipeline");
}, 120_000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OPENROUTER_API_TOKEN", "token-test");
  vi.stubEnv("AGENDA", "on");
  offers = catalog();
  store.pending = null;
  for (const key of Object.keys(rowsByTable)) delete rowsByTable[key];
  outbound.length = 0;
  attemptedOutbound.length = 0;
  updates.length = 0;
  sendFailure.on = false;
  createSessionBooking.mockReset();
  createSessionBooking.mockImplementation(async (input: { startUtc: string }) => okBooking(input));
  rescheduleForConversation.mockReset();
  rescheduleForConversation.mockResolvedValue({ label: "martes 6 a las 16:00", meetingLink: null });
  cancelBookingForConversation.mockReset();
  cancelBookingForConversation.mockResolvedValue({ bookingId: "bk_1", label: "martes 6 a las 16:00" });
  model({ action: "reply", text: "Respuesta del modelo." });
});

afterEach(() => {
  vi.useRealTimers();
});

const nothingExecuted = () => {
  expect(createSessionBooking).not.toHaveBeenCalled();
  expect(rescheduleForConversation).not.toHaveBeenCalled();
  expect(cancelBookingForConversation).not.toHaveBeenCalled();
};

const MODEL_TRIGGERS = ["hola", "la opción 4", "me interesa", "¿puedo cancelar mi cita?", "4"];

describe("las acciones de agenda del modelo NUNCA ejecutan", () => {
  it.each(MODEL_TRIGGERS)("book_slot con '%s' → solo deja la pendiente book y pregunta", async (text) => {
    model({ action: "book_slot", startUtc: at(TUE, "14:00") });
    await turn([
      { direction: "out", text: SHOWN, createdAt: SHOWN_AT },
      { direction: "in", text, createdAt: NOW },
    ]);
    nothingExecuted();
    expect(store.pending).toMatchObject({
      action: "book",
      startUtc: at(TUE, "14:00"),
      serviceId: null,
      professionalId: null,
    });
    expect(lastOut()).toContain("¿Quiere que agende su cita?");
  });

  it.each(MODEL_TRIGGERS)("book_slot con servicio y '%s' → la pendiente lleva servicio y profesional", async (text) => {
    offers = catalog(true);
    model({ action: "book_slot", startUtc: at(TUE, "14:00") });
    await turn([
      { direction: "out", text: SHOWN, createdAt: SHOWN_AT },
      { direction: "in", text, createdAt: NOW },
    ]);
    nothingExecuted();
    expect(store.pending).toMatchObject({
      action: "book",
      startUtc: at(TUE, "14:00"),
      serviceId: "svc_corte",
      professionalId: "pro_ana",
    });
  });

  it.each(MODEL_TRIGGERS)("reschedule_slot con '%s' → solo deja la pendiente reschedule y pregunta", async (text) => {
    model({ action: "reschedule_slot", startUtc: at(TUE, "16:00") });
    await turn([
      { direction: "out", text: SHOWN, createdAt: SHOWN_AT },
      { direction: "in", text, createdAt: NOW },
    ]);
    nothingExecuted();
    expect(store.pending).toMatchObject({ action: "reschedule", startUtc: at(TUE, "16:00") });
    expect(lastOut()).toMatch(/mueva su cita/);
  });

  it.each(MODEL_TRIGGERS)("cancel_booking con '%s' → solo deja la pendiente cancel y pregunta", async (text) => {
    model({ action: "cancel_booking" });
    await turn([{ direction: "in", text, createdAt: NOW }]);
    nothingExecuted();
    expect(store.pending).toMatchObject({ action: "cancel" });
    expect(lastOut()).toContain("Antes de cancelar necesito");
  });

  it("book_slot fuera del catálogo vigente → no deja pendiente y vuelve a ofrecer", async () => {
    model({ action: "book_slot", startUtc: at(TUE, "10:00") });
    await turn([
      { direction: "out", text: SHOWN, createdAt: SHOWN_AT },
      { direction: "in", text: "me interesa", createdAt: NOW },
    ]);
    nothingExecuted();
    expect(store.pending).toBeNull();
    expect(lastOut()).toMatch(/^• /m);
  });

  it("reschedule_slot fuera del catálogo vigente → no deja pendiente y vuelve a ofrecer", async () => {
    model({ action: "reschedule_slot", startUtc: at(TUE, "10:00") });
    await turn([
      { direction: "out", text: SHOWN, createdAt: SHOWN_AT },
      { direction: "in", text: "mejor más temprano", createdAt: NOW },
    ]);
    nothingExecuted();
    expect(store.pending).toBeNull();
    expect(lastOut()).toMatch(/^• /m);
  });
});

describe("solo una confirmación explícita ejecuta la pendiente, una sola vez", () => {
  it("book con servicio + 'sí' → createSessionBooking UNA vez con servicio y profesional", async () => {
    setPending("book", "14:00", { serviceId: "svc_corte", professionalId: "pro_ana" });
    offers = catalog(true);
    await turn([
      { direction: "out", text: PROPOSAL, createdAt: SHOWN_AT },
      { direction: "in", text: "sí", createdAt: NOW },
    ]);
    expect(createSessionBooking).toHaveBeenCalledTimes(1);
    expect(createSessionBooking.mock.calls[0]![0]).toMatchObject({
      organizationId: "org_1",
      conversationId: "cv_1",
      startUtc: at(TUE, "14:00"),
      serviceId: "svc_corte",
      professionalId: "pro_ana",
      requireOffer: true,
    });
    expect(store.pending).toBeNull();
  });

  it("flujo completo: book_slot del modelo → pendiente → 'sí' → cita con servicio y profesional", async () => {
    offers = catalog(true);
    model({ action: "book_slot", startUtc: at(TUE, "13:00") });
    await turn([
      { direction: "out", text: SHOWN, createdAt: SHOWN_AT },
      { direction: "in", text: "me interesa", createdAt: NOW },
    ]);
    nothingExecuted();
    const question = lastOut();
    await turn([
      { direction: "out", text: SHOWN, createdAt: SHOWN_AT },
      { direction: "in", text: "me interesa", createdAt: new Date(NOW.getTime() - 5_000) },
      { direction: "out", text: question, createdAt: new Date(NOW.getTime() - 2_000) },
      { direction: "in", text: "sí", createdAt: NOW },
    ]);
    expect(createSessionBooking).toHaveBeenCalledTimes(1);
    expect(createSessionBooking.mock.calls[0]![0]).toMatchObject({
      startUtc: at(TUE, "13:00"),
      serviceId: "svc_corte",
      professionalId: "pro_ana",
    });
  });

  it.each([
    ["book", "16:00"],
    ["reschedule", "16:00"],
    ["cancel", null],
  ] as const)("dos 'sí' CONCURRENTES con la pendiente %s → una sola ejecución", async (action, time) => {
    setPending(action, time);
    const history: Msg[] = [
      { direction: "out", text: PROPOSAL, createdAt: SHOWN_AT },
      { direction: "in", text: "sí", createdAt: NOW },
    ];
    setHistory(history);
    const { runAgentTurn } = await import("@/server/ai/pipeline");
    // Ambos turnos arrancan antes de que cualquiera termine.
    await Promise.all([runAgentTurn("cv_1", "org_1"), runAgentTurn("cv_1", "org_1")]);
    const executed =
      createSessionBooking.mock.calls.length +
      rescheduleForConversation.mock.calls.length +
      cancelBookingForConversation.mock.calls.length;
    expect(executed).toBe(1);
  });

  it("'claro que no' con una cancelación pendiente NO cancela", async () => {
    setPending("cancel", null);
    await turn([
      {
        direction: "out",
        text: "Antes de cancelar necesito tu confirmación: ¿confirmas que quieres cancelar tu cita? Responde «sí» y la cancelo.",
        createdAt: SHOWN_AT,
      },
      { direction: "in", text: "claro que no", createdAt: NOW },
    ]);
    expect(cancelBookingForConversation).not.toHaveBeenCalled();
  });

  it("'sí' a los 29 minutos ejecuta; a los 31 no", async () => {
    setPending("book", "16:00");
    vi.setSystemTime(new Date(NOW.getTime() + 29 * 60_000));
    await turn([
      { direction: "out", text: PROPOSAL, createdAt: NOW },
      { direction: "in", text: "sí", createdAt: new Date(NOW.getTime() + 29 * 60_000) },
    ]);
    expect(createSessionBooking).toHaveBeenCalledTimes(1);

    createSessionBooking.mockClear();
    vi.setSystemTime(NOW);
    setPending("book", "16:00");
    vi.setSystemTime(new Date(NOW.getTime() + 31 * 60_000));
    await turn([
      { direction: "out", text: PROPOSAL, createdAt: NOW },
      { direction: "in", text: "sí", createdAt: new Date(NOW.getTime() + 31 * 60_000) },
    ]);
    expect(createSessionBooking).not.toHaveBeenCalled();
  });
});

describe("un mensaje sin texto y la elección entre varias citas", () => {
  it("un audio, imagen o sticker (sin texto) descarta la pendiente", async () => {
    for (const action of ["book", "reschedule", "cancel"] as const) {
      setPending(action, action === "cancel" ? null : "16:00");
      await turn([
        { direction: "out", text: PROPOSAL, createdAt: SHOWN_AT },
        { direction: "in", text: null as unknown as string, createdAt: NOW },
      ]);
      nothingExecuted();
      expect(store.pending, action).toBeNull();
    }
  });

  it("con dos citas activas y sin decir cuál, lista ambas y no deja nada ejecutable", async () => {
    model({ action: "cancel_booking" });
    setHistory([{ direction: "in", text: "ya no voy a poder ir", createdAt: NOW }]);
    rowsByTable.booking = [
      BOOKING,
      { ...BOOKING, id: "bk_2", scheduledAt: new Date(at("2026-10-12", "18:00")) },
    ];
    outbound.length = 0;
    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_1", "org_1");
    nothingExecuted();
    expect(lastOut()).toContain("8 de octubre a las 10:00");
    expect(lastOut()).toContain("12 de octubre a las 18:00");
    expect(store.pending).toMatchObject({ action: "cancel", bookingId: null });
  });
});

describe("la pendiente se invalida con cualquier mensaje que no la confirme", () => {
  it.each([
    ["cambio de tema", "¿tienen estacionamiento?"],
    ["otra hora", "¿y tendrás algo más temprano?"],
    ["otra hora con 'sí'", "sí pero a las 5"],
    ["otro día", "vale, pero mejor el jueves"],
    ["negativa", "no gracias"],
  ])("%s ('%s') y luego 'sí' → NO ejecuta la propuesta vieja", async (_label, text) => {
    setPending("book", "16:00");
    await turn([
      { direction: "out", text: PROPOSAL, createdAt: SHOWN_AT },
      { direction: "in", text, createdAt: NOW },
    ]);
    nothingExecuted();
    expect(store.pending?.startUtc ?? null).not.toBe(at(TUE, "16:00"));
    const second = lastOut();

    model({ action: "reply", text: "¿En qué más le ayudo?" });
    await turn([
      { direction: "out", text: PROPOSAL, createdAt: SHOWN_AT },
      { direction: "in", text, createdAt: new Date(NOW.getTime() - 5_000) },
      { direction: "out", text: second || "Respuesta.", createdAt: new Date(NOW.getTime() - 3_000) },
      { direction: "in", text: "sí", createdAt: NOW },
    ]);
    expect(
      createSessionBooking.mock.calls.filter(
        ([input]) => (input as { startUtc: string }).startUtc === at(TUE, "16:00")
      )
    ).toHaveLength(0);
  });

  it.each(["book", "reschedule", "cancel"] as const)(
    "una duda con %s pendiente descarta la pendiente, el modelo responde y un 'sí' posterior NO ejecuta",
    async (action) => {
      setPending(action, action === "cancel" ? null : "16:00");
      model({ action: "reply", text: "Respuesta del modelo a la pregunta." });
      await turn([
        { direction: "out", text: PROPOSAL, createdAt: SHOWN_AT },
        { direction: "in", text: "sí, ¿y cuánto cuesta?", createdAt: NOW },
      ]);
      nothingExecuted();
      expect(chatJson).toHaveBeenCalled();
      expect(store.pending).toBeNull();
      const answer = lastOut();
      expect(answer).not.toMatch(/agende su cita|mueva su cita|cancelar su cita/);

      model({ action: "reply", text: "¿En qué más le ayudo?" });
      await turn([
        { direction: "out", text: PROPOSAL, createdAt: SHOWN_AT },
        { direction: "in", text: "sí, ¿y cuánto cuesta?", createdAt: new Date(NOW.getTime() - 5_000) },
        { direction: "out", text: answer, createdAt: new Date(NOW.getTime() - 3_000) },
        { direction: "in", text: "sí", createdAt: NOW },
      ]);
      nothingExecuted();
    }
  );
});

/**
 * Barrido: mensajes × acción del modelo × hora en/fuera del catálogo. Ninguna
 * combinación ejecuta; cada rama (pendiente, reoferta) debe ejercitarse.
 */
describe("barrido de acciones del modelo", () => {
  it("ninguna acción del modelo ejecuta; deja pendiente o vuelve a ofrecer", async () => {
    const branches = { pending: 0, reoffer: 0, cancelPending: 0 };
    const messages = [...MODEL_TRIGGERS, "sí", "ok", "dale", "a las 2", "cámbiala", "cancela", "gracias"];
    for (const text of messages) {
      for (const action of ["book_slot", "reschedule_slot", "cancel_booking"] as const) {
        for (const inCatalog of [true, false]) {
          offers = catalog();
          store.pending = null;
          createSessionBooking.mockClear();
          rescheduleForConversation.mockClear();
          cancelBookingForConversation.mockClear();
          const startUtc = at(TUE, inCatalog ? "14:00" : "10:00");
          model(action === "cancel_booking" ? { action } : { action, startUtc });
          await turn([
            { direction: "out", text: SHOWN, createdAt: SHOWN_AT },
            { direction: "in", text, createdAt: NOW },
          ]);
          const label = `${action} '${text}' inCatalog=${inCatalog}`;
          expect(createSessionBooking, label).not.toHaveBeenCalled();
          expect(rescheduleForConversation, label).not.toHaveBeenCalled();
          expect(cancelBookingForConversation, label).not.toHaveBeenCalled();
          const pending = currentPending();
          if (pending?.action === "cancel") branches.cancelPending += 1;
          else if (pending) {
            branches.pending += 1;
            // La pendiente siempre es un horario del catálogo vigente: la del
            // modelo o la que resolvió la selección determinista ("a las 2").
            expect(catalog().map((o) => o.startUtc), label).toContain(pending.startUtc);
            if (chatJson.mock.calls.length > 0) expect(pending.startUtc, label).toBe(startUtc);
          } else branches.reoffer += 1;
        }
      }
    }
    expect(branches.pending).toBeGreaterThan(0);
    expect(branches.reoffer).toBeGreaterThan(0);
    expect(branches.cancelPending).toBeGreaterThan(0);
  }, 120_000);

  it("con pendiente: cancelar y reprogramar solo con un 'sí' explícito; 'claro' a secas solo confirma agendar", async () => {
    // Cancelar y reprogramar exigen un "sí" claro; los acuses de recibo
    // ("ok", "dale", 👍, "claro"…) solo confirman una reserva. "claro que sí"
    // lleva un "sí" explícito y confirma todo.
    const CLEAR = [
      "sí", "si", "de acuerdo", "sí, gracias", "confirmo", "sí, cancélala", "claro que sí", "claro que si",
    ];
    const ACKNOWLEDGEMENTS = ["ok", "va", "dale", "perfecto", "está bien", "👍", "claro", "claro, gracias"];
    const POSITIVE = [...CLEAR, ...ACKNOWLEDGEMENTS];
    const expected = (action: "book" | "reschedule" | "cancel", text: string) =>
      CLEAR.includes(text) || (action === "book" && ACKNOWLEDGEMENTS.includes(text)) ? 1 : 0;
    const NEGATIVE = [
      "claro que no", "claro, que no", "claro que no la canceles", "claro, entiendo",
      "ok no", "por favor no", "sí pero a las 5", "vale, pero mejor el jueves",
      "sí, ¿y cuánto cuesta?", "va a llover?", "no, sí a las 5", "no", "no gracias", "mejor no",
      "si me pudieras decir…",
    ];
    const branches = { executed: 0, notExecuted: 0, acknowledgementOnly: 0 };
    // No puede pasar en vacío: cada confirmación clara tiene que haberse
    // ejecutado en las tres acciones (salvo "sí, cancélala" ante una reserva).
    const executedClear = new Set<string>();
    for (const action of ["book", "reschedule", "cancel"] as const) {
      for (const text of [...POSITIVE, ...NEGATIVE]) {
        // "sí, cancélala" responde a cancelar; ante una reserva no se fija aquí.
        if (action === "book" && text === "sí, cancélala") continue;
        setPending(action, action === "cancel" ? null : "16:00");
        createSessionBooking.mockClear();
        rescheduleForConversation.mockClear();
        cancelBookingForConversation.mockClear();
        model({ action: "reply", text: "Respuesta del modelo." });
        await turn([
          { direction: "out", text: PROPOSAL, createdAt: SHOWN_AT },
          { direction: "in", text, createdAt: NOW },
        ]);
        const executed =
          createSessionBooking.mock.calls.length +
          rescheduleForConversation.mock.calls.length +
          cancelBookingForConversation.mock.calls.length;
        const label = `${action} '${text}'`;
        expect(executed, label).toBe(expected(action, text));
        if (executed) branches.executed += 1;
        else branches.notExecuted += 1;
        if (executed && CLEAR.includes(text)) executedClear.add(`${action} ${text}`);
        if (!executed && ACKNOWLEDGEMENTS.includes(text)) branches.acknowledgementOnly += 1;
      }
    }
    expect(branches.executed).toBeGreaterThan(0);
    expect(branches.notExecuted).toBeGreaterThan(0);
    // Los acuses de recibo se probaron sin ejecutar en cancelar y reprogramar.
    expect(branches.acknowledgementOnly).toBe(ACKNOWLEDGEMENTS.length * 2);
    for (const action of ["book", "reschedule", "cancel"] as const) {
      for (const text of CLEAR) {
        if (action === "book" && text === "sí, cancélala") continue;
        expect(executedClear.has(`${action} ${text}`), `${action} '${text}' debió ejecutarse`).toBe(true);
      }
    }
  }, 120_000);
});

/**
 * Estructura: crear, mover y cancelar solo ocurre dentro del bloque que
 * consume la acción pendiente. Un camino nuevo que llame al motor desde otro
 * sitio del pipeline rompe esta prueba.
 */
describe("el motor de citas solo se invoca tras consumir la pendiente", () => {
  const pipeline = readFileSync(
    resolve(process.cwd(), "src/server/ai/pipeline.ts"),
    "utf8"
  ).replace(/\r\n/g, "\n");

  function callSites(name: string): number[] {
    return [...pipeline.matchAll(new RegExp(`await ${name}\\(`, "g"))].map((m) => m.index!);
  }

  it("bookSlot, rescheduleForConversation y handleCancellation: una llamada cada uno, dentro del bloque de consumo", () => {
    const start = pipeline.indexOf("await consumePendingAction(organizationId, conversationId, lastInbound.id)");
    const end = pipeline.indexOf("matchesCancellationIntent(inboundText)", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    for (const name of ["bookSlot", "rescheduleForConversation", "handleCancellation"]) {
      const sites = callSites(name);
      expect(sites, name).toHaveLength(1);
      expect(sites[0]!, name).toBeGreaterThan(start);
      expect(sites[0]!, name).toBeLessThan(end);
    }
    // cancelBookingForConversation solo vive dentro de handleCancellation.
    const cancelSites = callSites("cancelBookingForConversation");
    expect(cancelSites).toHaveLength(1);
    expect(cancelSites[0]!).toBeGreaterThan(pipeline.indexOf("async function handleCancellation("));
  });
});

/**
 * B-2 / F2 / F4 — Ejecutar una pendiente nunca deja al cliente sin respuesta
 * ni relanza el error al job (el reintento haría improvisar al modelo).
 * Tono usted: el perfil de estas pruebas no tutea.
 */
describe("fallos al ejecutar una pendiente: respuesta determinista, sin relanzar", () => {
  const RESCHEDULE_QUESTION =
    "Su cita actual: jueves, 8 de octubre a las 10:00. Tengo martes 6 a las 16:00. ¿Confirma que mueva su cita a ese horario?";
  const handoffs = () => updates.filter((u) => u.handoffAt instanceof Date && u.aiEnabled === false);

  async function confirmPending(action: "book" | "reschedule" | "cancel", question: string) {
    setPending(action, action === "cancel" ? null : "16:00");
    await turn([
      { direction: "out", text: question, createdAt: SHOWN_AT },
      { direction: "in", text: "sí", createdAt: NOW },
    ]);
  }

  it("B-2: reprogramar con slot_taken → ofrece alternativas y vuelve a preguntar, sin handoff", async () => {
    const { BookingError } = await import("@/server/agenda/service");
    rescheduleForConversation.mockRejectedValue(new BookingError("slot_taken", "Ese horario ya no está disponible"));
    await expect(confirmPending("reschedule", RESCHEDULE_QUESTION)).resolves.toBeUndefined();
    expect(rescheduleForConversation).toHaveBeenCalledTimes(1);
    expect(lastOut()).toContain("Ese horario ya no está disponible para mover su cita. Elija otro:");
    expect(lastOut()).toContain("• 12:00");
    expect(handoffs()).toHaveLength(0);
    expect(createSessionBooking).not.toHaveBeenCalled();
  });

  it("F2: reprogramar con un error de BD → mensaje determinista + handoff, sin relanzar", async () => {
    rescheduleForConversation.mockRejectedValue(new Error("connection terminated unexpectedly"));
    await expect(confirmPending("reschedule", RESCHEDULE_QUESTION)).resolves.toBeUndefined();
    expect(lastOut()).toBe("No pude mover su cita automáticamente. Un asesor continuará con usted.");
    expect(handoffs()).toHaveLength(1);
    expect(chatJson).not.toHaveBeenCalled();
  });

  it("F4: agendar con un error de BD → mensaje determinista + handoff, sin relanzar", async () => {
    createSessionBooking.mockRejectedValue(new Error("connection terminated unexpectedly"));
    await expect(confirmPending("book", PROPOSAL)).resolves.toBeUndefined();
    expect(lastOut()).toBe("No pude agendar su cita automáticamente. Un asesor continuará con usted.");
    expect(handoffs()).toHaveLength(1);
    expect(chatJson).not.toHaveBeenCalled();
  });

  it("F1 se mantiene: cancelar con un error de BD → mensaje determinista + handoff", async () => {
    cancelBookingForConversation.mockRejectedValue(new Error("connection terminated unexpectedly"));
    await expect(
      confirmPending("cancel", "¿Confirma que quiere cancelar su cita: jueves, 8 de octubre a las 10:00? Responda «sí» y la cancelo.")
    ).resolves.toBeUndefined();
    expect(lastOut()).toBe("No pude cancelar su cita automáticamente. Un asesor continuará con usted.");
    expect(handoffs()).toHaveLength(1);
  });

  it.each(["cancel", "book", "reschedule"] as const)(
    "fallo del ENVÍO tras %s ejecutado → no relanza, no dice que falló la acción y deja handoff",
    async (action) => {
      sendFailure.on = true;
      const question =
        action === "book" ? PROPOSAL : action === "reschedule" ? RESCHEDULE_QUESTION : "¿Confirma que quiere cancelar su cita?";
      await expect(confirmPending(action, question)).resolves.toBeUndefined();
      const engine = {
        cancel: cancelBookingForConversation,
        book: createSessionBooking,
        reschedule: rescheduleForConversation,
      }[action];
      expect(engine).toHaveBeenCalledTimes(1);
      // Se intentó el mensaje de éxito; nunca uno que diga que no se pudo.
      expect(attemptedOutbound.length).toBeGreaterThan(0);
      expect(attemptedOutbound.some((text) => /No pude/.test(text))).toBe(false);
      expect(handoffs()).toHaveLength(1);
      expect(chatJson).not.toHaveBeenCalled();
    }
  );
});

/**
 * B-3 — Si el cliente está cambiando su cita y el modelo responde `book_slot`,
 * la pendiente es `reschedule` sobre la cita existente: al confirmar se mueve,
 * no se crea una segunda.
 */
describe("book_slot del modelo en medio de un cambio de cita", () => {
  it("'quiero cambiar mi cita' → oferta → 'quiero las 4' [book_slot] → pregunta de mover → 'sí' mueve", async () => {
    model({ action: "book_slot", startUtc: at(TUE, "16:00") });
    const history: Msg[] = [
      { direction: "in", text: "quiero cambiar mi cita", createdAt: new Date(SHOWN_AT.getTime() - 5_000) },
      { direction: "out", text: SHOWN, createdAt: SHOWN_AT },
      { direction: "in", text: "quiero las 4", createdAt: NOW },
    ];
    await turn(history);
    expect(currentPending()).toMatchObject({ action: "reschedule", bookingId: BOOKING.id, startUtc: at(TUE, "16:00") });
    expect(lastOut()).toMatch(/Su cita actual: .*¿Confirma que mueva su cita a ese horario\?/);
    nothingExecuted();

    const question = lastOut();
    model({ action: "reply", text: "Respuesta del modelo." });
    await turn([
      ...history,
      { direction: "out", text: question, createdAt: new Date(NOW.getTime() + 1_000) },
      { direction: "in", text: "sí", createdAt: new Date(NOW.getTime() + 2_000) },
    ]);
    expect(rescheduleForConversation).toHaveBeenCalledTimes(1);
    expect(rescheduleForConversation.mock.calls[0]![0]).toMatchObject({ bookingId: BOOKING.id, startUtc: at(TUE, "16:00") });
    expect(createSessionBooking).not.toHaveBeenCalled();
  });

  it("la última pregunta del agente era de mover la cita → book_slot también queda como reschedule", async () => {
    model({ action: "book_slot", startUtc: at(TUE, "16:00") });
    await turn([
      {
        direction: "out",
        text: SHOWN.replace("Tengo estos horarios disponibles:", "Para cambiar su cita, elija uno de estos horarios disponibles:"),
        createdAt: SHOWN_AT,
      },
      { direction: "in", text: "quiero las 4", createdAt: NOW },
    ]);
    expect(currentPending()).toMatchObject({ action: "reschedule", bookingId: BOOKING.id });
    nothingExecuted();
  });

  it("sin cambio de cita en curso, book_slot sigue proponiendo una reserva nueva", async () => {
    model({ action: "book_slot", startUtc: at(TUE, "16:00") });
    await turn([
      { direction: "in", text: "quiero una cita", createdAt: new Date(SHOWN_AT.getTime() - 5_000) },
      { direction: "out", text: SHOWN, createdAt: SHOWN_AT },
      { direction: "in", text: "quiero las 4", createdAt: NOW },
    ]);
    expect(currentPending()).toMatchObject({ action: "book", bookingId: null });
  });
});
