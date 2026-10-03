import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveExpandRequest } from "@/server/agenda/expand";
import {
  isBareTimeSelection,
  resolveOfferedTimeSelection,
  selectedOfferConfirmationLabel,
} from "@/server/agenda/selection";
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

describe("resolveOfferedTimeSelection — incidente 2:20 → 14:20", () => {
  const shownAt = new Date("2026-09-30T02:10:19.000Z");
  const timezone = "America/Matamoros";
  const incidentOffers: OfferedSlot[] = [
    { startUtc: "2026-09-30T17:20:00.000Z", label: "mié 30 sep, 12:20" },
    { startUtc: "2026-09-30T18:00:00.000Z", label: "mié 30 sep, 13:00" },
    { startUtc: "2026-09-30T18:40:00.000Z", label: "mié 30 sep, 13:40" },
    { startUtc: "2026-09-30T19:20:00.000Z", label: "mié 30 sep, 14:20" },
    // El catálogo completo conserva otros días; no pertenecen a esta ventana.
    { startUtc: "2026-10-01T19:20:00.000Z", label: "jue 1 oct, 14:20" },
  ];
  const incidentWindow = [
    "Para la tarde tengo:",
    "Mañana miércoles, 30 de septiembre",
    "• 12:20",
    "• 13:00",
    "• 13:40",
    "• 14:20",
    "¿Cuál te funciona mejor?",
  ].join("\n");

  it.each(["2:20", "14:20", "a las 2:20", "el de las 2:20", "2:20 pm"])(
    "%s resuelve el 14:20 exacto de la última ventana",
    (text) => {
      const result = resolveOfferedTimeSelection({
        text,
        offers: incidentOffers,
        lastOutboundText: incidentWindow,
        timezone,
        shownAt,
      });
      expect(result).toMatchObject({
        kind: "match",
        offer: { startUtc: "2026-09-30T19:20:00.000Z" },
      });
    }
  );

  it("no elige arbitrariamente si 02:20 y 14:20 fueron mostrados", () => {
    const result = resolveOfferedTimeSelection({
      text: "2:20",
      offers: [
        { startUtc: "2026-09-30T07:20:00.000Z", label: "mié 30 sep, 02:20" },
        { startUtc: "2026-09-30T19:20:00.000Z", label: "mié 30 sep, 14:20" },
      ],
      lastOutboundText: [
        "Miércoles, 30 de septiembre",
        "• 02:20",
        "• 14:20",
      ].join("\n"),
      timezone,
      shownAt,
    });
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") expect(result.offers).toHaveLength(2);
  });

  it("un 14:20 repetido en varios días solo usa el día de la última ventana", () => {
    const result = resolveOfferedTimeSelection({
      text: "14:20",
      offers: incidentOffers,
      lastOutboundText: ["Jueves, 1 de octubre", "• 14:20"].join("\n"),
      timezone,
      shownAt,
    });
    expect(result).toMatchObject({
      kind: "match",
      offer: { startUtc: "2026-10-01T19:20:00.000Z" },
    });
  });

  it.each([
    ["la primera", "2026-09-30T17:20:00.000Z"],
    ["la segunda", "2026-09-30T18:00:00.000Z"],
    ["la última", "2026-09-30T19:20:00.000Z"],
  ])("%s selecciona por posición en la ventana mostrada", (text, startUtc) => {
    const result = resolveOfferedTimeSelection({
      text,
      offers: incidentOffers,
      lastOutboundText: incidentWindow,
      timezone,
      shownAt,
    });
    expect(result).toMatchObject({ kind: "match", offer: { startUtc } });
  });

  it.each(["el de las 11", "a las 11"])(
    "%s resuelve una hora sin minutos cuando es inequívoca",
    (text) => {
      const startUtc = "2026-09-30T16:00:00.000Z";
      const result = resolveOfferedTimeSelection({
        text,
        offers: [{ startUtc, label: "mié 30 sep, 11:00" }],
        lastOutboundText: [
          "Miércoles, 30 de septiembre",
          "• 11:00",
        ].join("\n"),
        timezone,
        shownAt,
      });
      expect(result).toMatchObject({ kind: "match", offer: { startUtc } });
    }
  );

  it("no elige arbitrariamente una hora sin minutos con varias coincidencias", () => {
    const result = resolveOfferedTimeSelection({
      text: "a las 11",
      offers: [
        { startUtc: "2026-09-30T16:00:00.000Z", label: "11:00" },
        { startUtc: "2026-09-30T16:30:00.000Z", label: "11:30" },
      ],
      lastOutboundText: [
        "Miércoles, 30 de septiembre",
        "• 11:00",
        "• 11:30",
      ].join("\n"),
      timezone,
      shownAt,
    });
    expect(result.kind).toBe("ambiguous");
  });

  it("forma la confirmación factual pedida por producto", () => {
    expect(
      selectedOfferConfirmationLabel(
        "2026-09-30T19:20:00.000Z",
        "America/Matamoros"
      )
    ).toBe("miércoles 30 a las 14:20");
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
const findSlot = vi.fn();
const findProfessionalSlot = vi.fn();
const createSessionBooking = vi.fn();
const chatJson = vi.fn();

vi.mock("@/lib/ai", () => ({ chatJson: (...args: unknown[]) => chatJson(...args) }));
vi.mock("@/server/agenda/settings", () => ({ getSettings: async () => settings }));
vi.mock("@/server/agenda/availability", () => ({
  computeAvailability: (...args: unknown[]) =>
    computeAvailability(...(args as [string, object | undefined])),
  findSlot: (...args: unknown[]) => findSlot(...args),
}));
vi.mock("@/server/agenda/professional-availability", () => ({
  findProfessionalSlot: (...args: unknown[]) => findProfessionalSlot(...args),
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

vi.mock("@/server/ai/observability", () => ({
  createAgentRun: async (input: {
    organizationId: string;
    conversationId: string;
  }) => ({
    runId: "test-agent-run",
    organizationId: input.organizationId,
    conversationId: input.conversationId,
  }),
  finishAgentRun: async () => {},
  hasActiveAgentRun: () => true,
  recordAgentAction: async () => {},
  recordAgentEvidence: async () => {},
  withAgentRun: async <T>(
    _context: unknown,
    fn: () => Promise<T>
  ): Promise<T> => fn(),
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
    settings.timezone = "UTC";
    chatJson.mockReset();
    computeAvailability.mockReset();
    findSlot.mockReset();
    findProfessionalSlot.mockReset();
    createSessionBooking.mockReset();
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

  it("resuelve '2:20' antes del LLM y crea la confirmación pendiente factual", async () => {
    const target = "2026-09-30T19:20:00.000Z";
    const shownAt = new Date("2026-09-30T02:10:19.000Z");
    const receivedAt = new Date("2026-09-30T02:10:36.000Z");
    settings.timezone = "America/Matamoros";
    vi.setSystemTime(receivedAt);
    offers = [
      { startUtc: "2026-09-30T17:20:00.000Z", label: "mié 30 sep, 12:20" },
      { startUtc: "2026-09-30T18:00:00.000Z", label: "mié 30 sep, 13:00" },
      { startUtc: "2026-09-30T18:40:00.000Z", label: "mié 30 sep, 13:40" },
      { startUtc: target, label: "mié 30 sep, 14:20" },
      { startUtc: "2026-10-01T19:20:00.000Z", label: "jue 1 oct, 14:20" },
    ];
    findSlot.mockResolvedValue({
      startUtc: target,
      endUtc: "2026-09-30T19:50:00.000Z",
      label: "mié 30 sep, 14:20",
    });
    chatJson.mockResolvedValue({
      ok: true,
      data: { action: "reply", text: "El horario de 14:20 no está disponible" },
    });
    queueTurno([
      {
        id: "m0",
        direction: "out",
        text: [
          "Para la tarde tengo:",
          "Mañana miércoles, 30 de septiembre",
          "• 12:20",
          "• 13:00",
          "• 13:40",
          "• 14:20",
          "¿Cuál te funciona mejor?",
        ].join("\n"),
        createdAt: shownAt,
      },
      { id: "m1", direction: "in", text: "2:20", createdAt: receivedAt },
    ]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(chatJson).not.toHaveBeenCalled();
    expect(ultimoTextoSaliente()).toBe(
      "Perfecto. Tengo miércoles 30 a las 14:20 disponible. ¿Quieres que agende tu cita?"
    );
    const pending = inserts.find((entry) => entry.values.action === "book");
    expect(pending?.values).toMatchObject({
      organizationId: "org_1",
      conversationId: "cv_lab",
      action: "book",
      serviceId: null,
      professionalId: null,
    });
    expect((pending?.values.startUtc as Date).toISOString()).toBe(target);
    expect(createSessionBooking).not.toHaveBeenCalled();
  });

  it("pide aclaración factual cuando 02:20 y 14:20 están en la ventana", async () => {
    settings.timezone = "America/Matamoros";
    const shownAt = new Date("2026-09-30T02:10:19.000Z");
    const receivedAt = new Date("2026-09-30T02:10:36.000Z");
    offers = [
      { startUtc: "2026-09-30T07:20:00.000Z", label: "mié 30 sep, 02:20" },
      { startUtc: "2026-09-30T19:20:00.000Z", label: "mié 30 sep, 14:20" },
    ];
    queueTurno([
      {
        id: "m0",
        direction: "out",
        text: "Miércoles, 30 de septiembre\n• 02:20\n• 14:20",
        createdAt: shownAt,
      },
      { id: "m1", direction: "in", text: "2:20", createdAt: receivedAt },
    ]);

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(chatJson).not.toHaveBeenCalled();
    expect(ultimoTextoSaliente()).toContain("Encontré más de una opción");
    expect(ultimoTextoSaliente()).toContain("02:20");
    expect(ultimoTextoSaliente()).toContain("14:20");
    expect(inserts.some((entry) => entry.values.action === "book")).toBe(false);
  });

  it("la confirmación posterior crea exactamente una cita", async () => {
    const target = "2026-09-30T19:20:00.000Z";
    createSessionBooking.mockResolvedValue({
      booking: { durationMinutes: 30 },
      meetingLink: null,
      linkPending: false,
      label: "mié 30 sep, 14:20",
    });
    selectQueue.push(
      [CONVERSACION_DE_PRUEBA],
      [PERFIL],
      [{ id: "m1", direction: "in", text: "sí", createdAt: new Date() }],
      [
        {
          id: "paa_1",
          organizationId: "org_1",
          conversationId: "cv_lab",
          action: "book",
          bookingId: null,
          startUtc: new Date(target),
          serviceId: null,
          professionalId: null,
          expiresAt: new Date(Date.now() + 60_000),
        },
      ]
    );

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(createSessionBooking).toHaveBeenCalledTimes(1);
    expect(createSessionBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_1",
        conversationId: "cv_lab",
        startUtc: target,
        source: "ai",
        requireOffer: true,
      })
    );
    expect(ultimoTextoSaliente()).toContain("¡Listo! Te agendé");
  });

  it("un conflicto real entre oferta y confirmación responde slot_taken", async () => {
    const target = "2026-09-30T19:20:00.000Z";
    const { BookingError } = await import("@/server/agenda/service");
    createSessionBooking.mockRejectedValue(
      new BookingError("slot_taken", "Ese horario acaba de ocuparse", [
        { startUtc: "2026-09-30T20:00:00.000Z", label: "mié 30 sep, 15:00" },
      ])
    );
    selectQueue.push(
      [CONVERSACION_DE_PRUEBA],
      [PERFIL],
      [{ id: "m1", direction: "in", text: "sí", createdAt: new Date() }],
      [
        {
          id: "paa_1",
          organizationId: "org_1",
          conversationId: "cv_lab",
          action: "book",
          bookingId: null,
          startUtc: new Date(target),
          serviceId: null,
          professionalId: null,
          expiresAt: new Date(Date.now() + 60_000),
        },
      ]
    );

    const { runAgentTurn } = await import("@/server/ai/pipeline");
    await runAgentTurn("cv_lab");

    expect(createSessionBooking).toHaveBeenCalledTimes(1);
    expect(ultimoTextoSaliente()).toContain("Se me acaba de ocupar ese horario");
    expect(ultimoTextoSaliente()).toContain("15:00");
    expect(ultimoTextoSaliente()).not.toContain("Te agendé");
  });
});
