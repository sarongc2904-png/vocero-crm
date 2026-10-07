import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OfferedSlot } from "@/server/agenda/offers";

/**
 * Guardia de confirmación de citas contra un Postgres REAL.
 *
 * Pipeline real (`runAgentTurn`), tabla `pending_agenda_action` real,
 * `service.ts` real (crear, mover y cancelar), `offered_slot` y `message`
 * reales. Se simulan solo el modelo, los ajustes de agenda y la disponibilidad
 * del calendario. Todas las conversaciones son de prueba (`isTest`): nunca se
 * llama a WhatsApp.
 *
 * Opcional: corre solo con `VOCERO_TEST_PG_URL` apuntando a una base
 * DESCARTABLE con las migraciones aplicadas (`pnpm db:migrate`). Sin la
 * variable se omite, como en CI. Ejemplo:
 *
 *   VOCERO_TEST_PG_URL=postgres://u@127.0.0.1:55432/db pnpm vitest run \
 *     tests/unit/booking-confirmation-postgres.test.ts
 */

const PG_URL = process.env.VOCERO_TEST_PG_URL;

vi.hoisted(() => {
  const url = process.env.VOCERO_TEST_PG_URL;
  if (!url) return;
  process.env.DATABASE_URL = url;
  process.env.APP_BASE_URL ??= "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET ??= "pg-test-secret-0123456789";
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
  process.env.META_WEBHOOK_VERIFY_TOKEN ??= "pg-test-verify";
  process.env.OPENROUTER_API_TOKEN = "pg-test-token";
  process.env.AGENDA = "on";
});

const TZ = "America/Mexico_City";

const h = vi.hoisted(() => ({
  available: [] as { startUtc: string; label: string; serviceId?: string | null; professionalId?: string | null }[],
  modelData: { action: "reply", text: "Respuesta del modelo." } as Record<string, unknown>,
  modelCalls: 0,
}));

vi.mock("@/lib/ai", () => ({
  chatJson: async () => {
    h.modelCalls += 1;
    return { ok: true, data: h.modelData };
  },
}));
vi.mock("@/server/agenda/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/agenda/settings")>()),
  getSettings: async () => ({
    weeklyHours: Object.fromEntries(
      ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [
        day,
        [{ start: "08:00", end: "20:00" }],
      ])
    ),
    slotMinutes: 30,
    bufferMinutes: 0,
    minNoticeHours: 2,
    maxDaysAhead: 14,
    timezone: "America/Mexico_City",
    connector: "enlace-fijo",
    meetingLink: null,
  }),
}));
vi.mock("@/server/agenda/availability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/agenda/availability")>()),
  computeAvailability: async () =>
    h.available.map((slot) => ({ startUtc: slot.startUtc, endUtc: slot.startUtc, label: slot.label })),
  findSlot: async (_org: string, iso: string) =>
    h.available.find((slot) => slot.startUtc === new Date(iso).toISOString()) ?? null,
}));
vi.mock("@/server/agenda/professional-availability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/agenda/professional-availability")>()),
  getSchedulingContext: async (input: { serviceId: string; professionalId: string }) => ({
    service: { id: input.serviceId, name: "Corte", durationMinutes: 45, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
    professional: { id: input.professionalId, name: "Pro", timezone: "America/Mexico_City" },
  }),
  findProfessionalSlot: async (_org: string, input: { startUtc: string; professionalId: string }) =>
    h.available.find(
      (slot) =>
        slot.startUtc === new Date(input.startUtc).toISOString() &&
        (!slot.professionalId || slot.professionalId === input.professionalId)
    ) ?? null,
}));

/** Instante UTC de `hh:mm` hora de México, `daysAhead` días después de hoy. */
function slotAt(daysAhead: number, hhmm: string): string {
  const base = new Date(Date.now() + daysAhead * 86_400_000);
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(base);
  return new Date(`${ymd}T${hhmm}:00-06:00`).toISOString();
}

/** "viernes, 9 de octubre": así nombra el agente el día de una cita. */
function dayName(startUtc: string): string {
  return new Intl.DateTimeFormat("es-MX", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }).format(
    new Date(startUtc)
  );
}

function weekday(startUtc: string): string {
  return new Intl.DateTimeFormat("es-MX", { timeZone: TZ, weekday: "long" }).format(new Date(startUtc));
}

async function db() {
  const { getDb, schema } = await import("@/lib/db");
  return { d: getDb(), s: schema };
}

type Ctx = { org: string; contact: string; conv: string; svc: string; proA: string; proB: string };
let seq = 0;

async function seed(tone: string | null = "informal, tutea"): Promise<Ctx> {
  const { d, s } = await db();
  seq += 1;
  const tag = `${Date.now().toString(36)}${seq}`;
  const ctx: Ctx = {
    org: `org_pg${tag}`,
    contact: `ct_pg${tag}`,
    conv: `cv_pg${tag}`,
    svc: `svc_pg${tag}`,
    proA: `pro_pgA${tag}`,
    proB: `pro_pgB${tag}`,
  };
  await d.insert(s.organization).values({ id: ctx.org, name: `Org ${tag}` });
  await d.insert(s.contact).values({
    id: ctx.contact,
    organizationId: ctx.org,
    waIdentity: `52155${tag}`,
    name: "Cliente",
  } as never);
  await d.insert(s.conversation).values({
    id: ctx.conv,
    organizationId: ctx.org,
    contactId: ctx.contact,
    isTest: true,
    lastInboundAt: new Date(),
  });
  await d.insert(s.agentProfile).values({
    id: `agp_pg${tag}`,
    organizationId: ctx.org,
    enabled: true,
    name: "Agente",
    tone,
  } as never);
  await d.insert(s.service).values({
    id: ctx.svc,
    organizationId: ctx.org,
    name: "Corte",
    durationMinutes: 45,
    priceCents: 30000,
  } as never);
  await d.insert(s.professional).values([
    { id: ctx.proA, organizationId: ctx.org, name: "Ana" },
    { id: ctx.proB, organizationId: ctx.org, name: "Beto" },
  ] as never);
  return ctx;
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 3));

async function addMessage(
  ctx: Ctx,
  direction: "in" | "out",
  text: string | null,
  extra: Record<string, unknown> = {}
) {
  const { d, s } = await db();
  await pause();
  await d.insert(s.message).values({
    id: `msg_pg${Math.random().toString(36).slice(2)}`,
    organizationId: ctx.org,
    conversationId: ctx.conv,
    direction,
    type: text === null ? "audio" : "text",
    text,
    status: direction === "in" ? "delivered" : "sent",
    origin: "operator",
    ...extra,
  } as never);
  await pause();
}

async function addBooking(ctx: Ctx, startUtc: string): Promise<string> {
  const { d, s } = await db();
  const id = `bk_pg${Math.random().toString(36).slice(2, 10)}`;
  await d.insert(s.booking).values({
    id,
    organizationId: ctx.org,
    kind: "session",
    status: "agendada",
    source: "manual",
    contactId: ctx.contact,
    conversationId: ctx.conv,
    scheduledAt: new Date(startUtc),
    durationMinutes: 30,
    timezone: TZ,
    isTest: true,
  } as never);
  return id;
}

async function bookings(ctx: Ctx) {
  const { d, s } = await db();
  const { and, asc, eq } = await import("drizzle-orm");
  return d
    .select({
      id: s.booking.id,
      status: s.booking.status,
      at: s.booking.scheduledAt,
      professionalId: s.booking.professionalId,
    })
    .from(s.booking)
    .where(and(eq(s.booking.organizationId, ctx.org), eq(s.booking.kind, "session")))
    .orderBy(asc(s.booking.createdAt));
}

async function pending(ctx: Ctx) {
  const { d, s } = await db();
  const { eq } = await import("drizzle-orm");
  const rows = await d
    .select()
    .from(s.pendingAgendaAction)
    .where(eq(s.pendingAgendaAction.conversationId, ctx.conv));
  return rows[0] ?? null;
}

async function outbound(ctx: Ctx) {
  const { d, s } = await db();
  const { and, asc, eq } = await import("drizzle-orm");
  const rows = await d
    .select({ text: s.message.text })
    .from(s.message)
    .where(and(eq(s.message.conversationId, ctx.conv), eq(s.message.direction, "out")))
    .orderBy(asc(s.message.createdAt));
  return rows.map((row) => row.text ?? "");
}

/** Un turno real: el mensaje del cliente y `runAgentTurn`. Devuelve lo que respondió el agente. */
async function turn(ctx: Ctx, text: string | null, model?: Record<string, unknown>): Promise<string[]> {
  h.modelData = model ?? { action: "reply", text: "Respuesta del modelo." };
  h.modelCalls = 0;
  const before = (await outbound(ctx)).length;
  await addMessage(ctx, "in", text);
  const { runAgentTurn } = await import("@/server/ai/pipeline");
  await runAgentTurn(ctx.conv, ctx.org);
  await pause();
  return (await outbound(ctx)).slice(before);
}

/** Muestra una oferta generada por el propio motor (texto y catálogo reales). */
async function showOffer(ctx: Ctx, slots: OfferedSlot[], ask = "¿qué horarios tienes?") {
  h.available = slots;
  const replies = await turn(ctx, ask, { action: "offer_slots" });
  expect(replies.at(-1)).toContain("•");
  return replies.at(-1)!;
}

async function cancelQuestion(ctx: Ctx) {
  const replies = await turn(ctx, "cancela mi cita");
  expect(replies.at(-1)).toMatch(/confirmas que quieres cancelar tu cita/i);
  expect((await pending(ctx))?.action).toBe("cancel");
  return replies.at(-1)!;
}

describe.skipIf(!PG_URL)("guardia de confirmación con Postgres real", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    await import("@/server/ai/pipeline");
  }, 120_000);

  afterAll(async () => {
    const { getSql } = await import("@/lib/db");
    await getSql().end({ timeout: 5 });
  });

  describe("la pregunta nombra la cita y se ejecuta sobre ESA cita", () => {
    it("una cita: la pregunta dice fecha y hora; 'sí' la cancela", async () => {
      const ctx = await seed();
      const id = await addBooking(ctx, slotAt(3, "10:00"));
      const question = await cancelQuestion(ctx);
      expect(question).toContain(dayName(slotAt(3, "10:00")));
      expect(question).toContain("10:00");
      expect((await pending(ctx))?.bookingId).toBe(id);

      const done = await turn(ctx, "sí");
      expect(done.at(-1)).toContain("cancelé tu cita");
      // El éxito nombra la cita cancelada: fecha y hora.
      expect(done.at(-1)).toContain(dayName(slotAt(3, "10:00")));
      expect(done.at(-1)).toContain("10:00");
      expect((await bookings(ctx)).map((b) => b.status)).toEqual(["cancelada"]);
    });

    it("B1: dos citas, pide cancelar la lejana por su día → se cancela la lejana", async () => {
      const ctx = await seed();
      const near = await addBooking(ctx, slotAt(2, "10:00"));
      const far = await addBooking(ctx, slotAt(5, "18:00"));
      const replies = await turn(ctx, `cancela mi cita del ${weekday(slotAt(5, "18:00"))}`);
      expect(replies.at(-1)).toContain(dayName(slotAt(5, "18:00")));
      expect(replies.at(-1)).toContain("18:00");
      expect((await pending(ctx))?.bookingId).toBe(far);

      await turn(ctx, "sí");
      const after = Object.fromEntries((await bookings(ctx)).map((b) => [b.id, b.status]));
      expect(after[far]).toBe("cancelada");
      expect(after[near]).toBe("agendada");
    });

    it("B1: dos citas y un mensaje que no dice cuál → lista ambas, 'sí' no cancela nada, 'la segunda' pregunta por esa", async () => {
      const ctx = await seed();
      const near = await addBooking(ctx, slotAt(2, "10:00"));
      const far = await addBooking(ctx, slotAt(5, "18:00"));
      const listing = await turn(ctx, "cancela mi cita");
      expect(listing.at(-1)).toContain(dayName(slotAt(2, "10:00")));
      expect(listing.at(-1)).toContain(dayName(slotAt(5, "18:00")));

      await turn(ctx, "sí");
      expect((await bookings(ctx)).every((b) => b.status === "agendada")).toBe(true);

      await turn(ctx, "cancela mi cita");
      const question = await turn(ctx, "la segunda");
      expect(question.at(-1)).toContain(dayName(slotAt(5, "18:00")));
      expect((await pending(ctx))?.bookingId).toBe(far);
      await turn(ctx, "sí");
      const after = Object.fromEntries((await bookings(ctx)).map((b) => [b.id, b.status]));
      expect(after[far]).toBe("cancelada");
      expect(after[near]).toBe("agendada");
    });

    it("al confirmar se valida que la cita siga activa: si ya se canceló, no se cancela otra", async () => {
      const ctx = await seed();
      const first = await addBooking(ctx, slotAt(2, "10:00"));
      const second = await addBooking(ctx, slotAt(5, "18:00"));
      await turn(ctx, `cancela mi cita del ${weekday(slotAt(2, "10:00"))}`);
      expect((await pending(ctx))?.bookingId).toBe(first);
      const { d, s } = await db();
      const { eq } = await import("drizzle-orm");
      await d.update(s.booking).set({ status: "cancelada" }).where(eq(s.booking.id, first));

      const reply = await turn(ctx, "sí");
      expect(reply.at(-1)).toMatch(/no encontr/i);
      const after = Object.fromEntries((await bookings(ctx)).map((b) => [b.id, b.status]));
      expect(after[second]).toBe("agendada");
    });
  });

  describe("R1: reprogramar MUEVE la cita, no crea otra", () => {
    it("elige una hora de la oferta de reprogramación → pregunta con hora vieja y nueva → 'sí' mueve la misma cita", async () => {
      const ctx = await seed();
      const id = await addBooking(ctx, slotAt(3, "10:00"));
      await showOffer(ctx, [{ startUtc: slotAt(4, "11:00"), label: "11:00" }], "quiero cambiar mi cita");
      const question = await turn(ctx, "11:00", { action: "reschedule_slot", startUtc: slotAt(4, "11:00") });
      expect(question.at(-1)).toContain(dayName(slotAt(3, "10:00")));
      expect(question.at(-1)).toContain("10:00");
      expect(question.at(-1)).toContain("11:00");
      const p = await pending(ctx);
      expect(p?.action).toBe("reschedule");
      expect(p?.bookingId).toBe(id);

      await turn(ctx, "sí");
      const after = await bookings(ctx);
      expect(after).toHaveLength(1);
      expect(after[0]!.id).toBe(id);
      expect(after[0]!.at.toISOString()).toBe(slotAt(4, "11:00"));
    });

    it("reschedule_slot del modelo con dos citas y la cita nombrada → mueve esa", async () => {
      const ctx = await seed();
      const near = await addBooking(ctx, slotAt(2, "10:00"));
      const far = await addBooking(ctx, slotAt(5, "18:00"));
      await showOffer(ctx, [{ startUtc: slotAt(6, "11:00"), label: "11:00" }], "quiero mover una cita");
      const question = await turn(ctx, `mueve la del ${weekday(slotAt(5, "18:00"))} a esa`, {
        action: "reschedule_slot",
        startUtc: slotAt(6, "11:00"),
      });
      expect(question.at(-1)).toContain("18:00");
      expect((await pending(ctx))?.bookingId).toBe(far);
      await turn(ctx, "sí");
      const after = Object.fromEntries((await bookings(ctx)).map((b) => [b.id, b.at.toISOString()]));
      expect(after[far]).toBe(slotAt(6, "11:00"));
      expect(after[near]).toBe(slotAt(2, "10:00"));
      expect(Object.keys(after)).toHaveLength(2);
    });
  });

  describe("X1 / X2 / C3b: un 'sí' que no responde a la pregunta no ejecuta", () => {
    it("X1: un operador escribe después de la pregunta → el 'sí' no cancela", async () => {
      const ctx = await seed();
      await addBooking(ctx, slotAt(3, "10:00"));
      await cancelQuestion(ctx);
      await addMessage(ctx, "out", "Hola, soy Laura del equipo. ¿Te mando la ubicación?", { origin: "operator" });
      await turn(ctx, "sí");
      expect((await bookings(ctx))[0]!.status).toBe("agendada");
      expect(await pending(ctx)).toBeNull();
    });

    it("X2: tras un handoff y reactivar la IA, el 'sí' no cancela", async () => {
      const ctx = await seed();
      await addBooking(ctx, slotAt(3, "10:00"));
      await cancelQuestion(ctx);
      await turn(ctx, "quiero hablar con un asesor");
      const { d, s } = await db();
      const { eq } = await import("drizzle-orm");
      // Reactivación por un camino que NO limpia la pendiente: la guardia no
      // debe depender de que todos los caminos la borren.
      await pause();
      await d
        .update(s.conversation)
        .set({ handoffAt: null, handoffReason: null, aiEnabled: true, aiContextResetAt: new Date() })
        .where(eq(s.conversation.id, ctx.conv));
      await turn(ctx, "sí");
      expect((await bookings(ctx))[0]!.status).toBe("agendada");
    });

    it("X2b: reiniciar la sesión sin handoff también invalida la pendiente", async () => {
      const ctx = await seed();
      await addBooking(ctx, slotAt(3, "10:00"));
      await cancelQuestion(ctx);
      const { d, s } = await db();
      const { eq } = await import("drizzle-orm");
      await pause();
      await d.update(s.conversation).set({ aiContextResetAt: new Date() }).where(eq(s.conversation.id, ctx.conv));
      await turn(ctx, "sí");
      expect((await bookings(ctx))[0]!.status).toBe("agendada");
    });

    it.each(["audio", "image", "sticker"])("C3b: un %s sin texto descarta la pendiente", async (kind) => {
      const ctx = await seed();
      await addBooking(ctx, slotAt(3, "10:00"));
      await cancelQuestion(ctx);
      h.modelData = { action: "reply", text: "No puedo ver eso. ¿Te paso los precios?" };
      const { d, s } = await db();
      await pause();
      await d.insert(s.message).values({
        id: `msg_pg${Math.random().toString(36).slice(2)}`,
        organizationId: ctx.org,
        conversationId: ctx.conv,
        direction: "in",
        type: kind,
        text: null,
        status: "delivered",
      } as never);
      const { runAgentTurn } = await import("@/server/ai/pipeline");
      await runAgentTurn(ctx.conv, ctx.org);
      expect(await pending(ctx)).toBeNull();
      await turn(ctx, "sí");
      expect((await bookings(ctx))[0]!.status).toBe("agendada");
    });
  });

  describe("B3: cancelar y reprogramar exigen un 'sí' claro", () => {
    it.each(["ok gracias", "👍", "ok", "gracias", "dale"])("cancelación pendiente + '%s' → no cancela y la descarta", async (text) => {
      const ctx = await seed();
      await addBooking(ctx, slotAt(3, "10:00"));
      await cancelQuestion(ctx);
      await turn(ctx, text);
      expect((await bookings(ctx))[0]!.status).toBe("agendada");
      expect(await pending(ctx)).toBeNull();
    });

    it.each(["sí", "Sí, cancélala", "confirmo", "si, gracias", "claro que sí"])("cancelación pendiente + '%s' → cancela", async (text) => {
      const ctx = await seed();
      await addBooking(ctx, slotAt(3, "10:00"));
      await cancelQuestion(ctx);
      await turn(ctx, text);
      expect((await bookings(ctx))[0]!.status).toBe("cancelada");
    });

    it("reprogramación pendiente + '👍' → no mueve", async () => {
      const ctx = await seed();
      const id = await addBooking(ctx, slotAt(3, "10:00"));
      await showOffer(ctx, [{ startUtc: slotAt(4, "11:00"), label: "11:00" }], "quiero cambiar mi cita");
      await turn(ctx, "11:00", { action: "reschedule_slot", startUtc: slotAt(4, "11:00") });
      await turn(ctx, "👍");
      const after = await bookings(ctx);
      expect(after.find((b) => b.id === id)!.at.toISOString()).toBe(slotAt(3, "10:00"));
    });

    it("agendar se mantiene: '👍' a una propuesta de reserva sí agenda (documentado)", async () => {
      const ctx = await seed();
      await showOffer(ctx, [{ startUtc: slotAt(2, "16:00"), label: "16:00" }]);
      await turn(ctx, "a las 16:00", { action: "book_slot", startUtc: slotAt(2, "16:00") });
      expect((await pending(ctx))?.action).toBe("book");
      await turn(ctx, "👍");
      expect((await bookings(ctx)).map((b) => b.status)).toEqual(["agendada"]);
    });
  });

  describe("una sola ejecución", () => {
    it("'sí' doble: la segunda no repite ni ejecuta nada", async () => {
      const ctx = await seed();
      await addBooking(ctx, slotAt(3, "10:00"));
      await addBooking(ctx, slotAt(5, "10:00"));
      await turn(ctx, `cancela mi cita del ${weekday(slotAt(3, "10:00"))}`);
      await turn(ctx, "sí");
      await turn(ctx, "sí");
      expect((await bookings(ctx)).map((b) => b.status).sort()).toEqual(["agendada", "cancelada"]);
    });

    it("tres 'sí' concurrentes → una sola cancelación", async () => {
      const ctx = await seed();
      await addBooking(ctx, slotAt(3, "10:00"));
      await addBooking(ctx, slotAt(5, "10:00"));
      await turn(ctx, `cancela mi cita del ${weekday(slotAt(3, "10:00"))}`);
      await addMessage(ctx, "in", "sí");
      const { runAgentTurn } = await import("@/server/ai/pipeline");
      await Promise.all([1, 2, 3].map(() => runAgentTurn(ctx.conv, ctx.org)));
      expect((await bookings(ctx)).filter((b) => b.status === "cancelada")).toHaveLength(1);
    });

    it("tres 'sí' concurrentes con una reserva pendiente → una sola cita", async () => {
      const ctx = await seed();
      await showOffer(ctx, [{ startUtc: slotAt(2, "16:00"), label: "16:00" }]);
      await turn(ctx, "a las 16:00", { action: "book_slot", startUtc: slotAt(2, "16:00") });
      await addMessage(ctx, "in", "sí");
      const { runAgentTurn } = await import("@/server/ai/pipeline");
      await Promise.all([1, 2, 3].map(() => runAgentTurn(ctx.conv, ctx.org)));
      expect(await bookings(ctx)).toHaveLength(1);
    });

    it("vigencia: 'sí' con un minuto por vencer ejecuta; vencida, no", async () => {
      const { d, s } = await db();
      const { eq } = await import("drizzle-orm");
      const expireIn = (ctx: Ctx, minutes: number) =>
        d
          .update(s.pendingAgendaAction)
          .set({ expiresAt: new Date(Date.now() + minutes * 60_000) })
          .where(eq(s.pendingAgendaAction.conversationId, ctx.conv));

      const late = await seed();
      await addBooking(late, slotAt(3, "10:00"));
      await cancelQuestion(late);
      await expireIn(late, -1);
      await turn(late, "sí");
      expect((await bookings(late))[0]!.status).toBe("agendada");

      const onTime = await seed();
      await addBooking(onTime, slotAt(3, "10:00"));
      await cancelQuestion(onTime);
      await expireIn(onTime, 1);
      await turn(onTime, "sí");
      expect((await bookings(onTime))[0]!.status).toBe("cancelada");
    });
  });

  describe("la pregunta legítima del cliente no se pierde", () => {
    it("'sí, ¿y cuánto cuesta?' con cancelación pendiente → responde la pregunta y no cancela", async () => {
      const ctx = await seed();
      await addBooking(ctx, slotAt(3, "10:00"));
      await cancelQuestion(ctx);
      const replies = await turn(ctx, "sí, ¿y cuánto cuesta?", { action: "reply", text: "El corte cuesta $300." });
      expect(replies).toContain("El corte cuesta $300.");
      expect((await bookings(ctx))[0]!.status).toBe("agendada");
      expect(await pending(ctx)).toBeNull();
    });
  });

  describe("tono", () => {
    it("usted: pregunta del atajo, éxito de cancelar y de reprogramar", async () => {
      const ctx = await seed(null);
      await addBooking(ctx, slotAt(3, "10:00"));
      const question = await turn(ctx, "cancela mi cita");
      expect(question.at(-1)).toMatch(/necesito su confirmación: ¿confirma que quiere cancelar su cita/);
      expect(question.at(-1)).toContain("Responda «sí»");
      const done = await turn(ctx, "sí");
      expect(done.at(-1)).toMatch(/^Listo, cancelé su cita/);

      const other = await seed(null);
      await addBooking(other, slotAt(3, "10:00"));
      await showOffer(other, [{ startUtc: slotAt(4, "11:00"), label: "11:00" }], "quiero cambiar mi cita");
      const ask = await turn(other, "11:00", { action: "reschedule_slot", startUtc: slotAt(4, "11:00") });
      expect(ask.at(-1)).toContain("¿Confirma que mueva su cita");
      expect(ask.at(-1)).not.toMatch(/\btu cita\b/);
      const moved = await turn(other, "sí");
      expect(moved.at(-1)).toMatch(/Reprogramé su cita/);
    });
  });

  describe("dos ofertas a la misma hora con distinto profesional", () => {
    async function twoPros(ctx: Ctx) {
      const { d, s } = await db();
      const at = slotAt(2, "16:00");
      h.available = [
        { startUtc: at, label: "16:00", serviceId: ctx.svc, professionalId: ctx.proA },
        { startUtc: at, label: "16:00", serviceId: ctx.svc, professionalId: ctx.proB },
      ];
      await d.insert(s.offeredSlot).values(
        [ctx.proA, ctx.proB].map((professionalId, i) => ({
          id: `os_pg${ctx.conv}${i}`,
          organizationId: ctx.org,
          conversationId: ctx.conv,
          serviceId: ctx.svc,
          professionalId,
          startUtc: new Date(at),
          label: "16:00",
        })) as never
      );
      return at;
    }

    it("sin decir con quién → pregunta nombrando a cada profesional y no deja pendiente", async () => {
      const ctx = await seed();
      const at = await twoPros(ctx);
      const replies = await turn(ctx, "quiero agendar a las 4 de la tarde", { action: "book_slot", startUtc: at });
      expect(replies.at(-1)).toContain("Ana");
      expect(replies.at(-1)).toContain("Beto");
      expect(await pending(ctx)).toBeNull();
    });

    it("'con Beto' → la pendiente y la cita son con Beto", async () => {
      const ctx = await seed();
      const at = await twoPros(ctx);
      await turn(ctx, "quiero agendar a las 4 de la tarde con Beto", { action: "book_slot", startUtc: at });
      expect((await pending(ctx))?.professionalId).toBe(ctx.proB);
      await turn(ctx, "sí");
      expect((await bookings(ctx))[0]?.professionalId).toBe(ctx.proB);
    });
  });

  describe("la pendiente está ligada a su pregunta (id = id del mensaje)", () => {
    async function lastOutbound(ctx: Ctx) {
      const { d, s } = await db();
      const { and, desc, eq } = await import("drizzle-orm");
      return (
        await d
          .select({ id: s.message.id, createdAt: s.message.createdAt })
          .from(s.message)
          .where(and(eq(s.message.conversationId, ctx.conv), eq(s.message.direction, "out")))
          .orderBy(desc(s.message.createdAt))
          .limit(1)
      )[0]!;
    }

    it("el id guardado no coincide con el último saliente → no ejecutable; coincide → ejecutable", async () => {
      const ctx = await seed();
      const bookingId = await addBooking(ctx, slotAt(3, "10:00"));
      const actions = await import("@/server/agenda/pending-actions");
      await addMessage(ctx, "out", "¿Confirmas? (pregunta vieja)");
      const older = (await lastOutbound(ctx)).id;
      await addMessage(ctx, "out", "¿Confirmas? (pregunta nueva)");
      const newest = (await lastOutbound(ctx)).id;
      const yes = `msg_pgyes${ctx.conv}`;
      await addMessage(ctx, "in", "sí", { id: yes });

      await actions.setPendingAction({
        organizationId: ctx.org,
        conversationId: ctx.conv,
        action: "cancel",
        bookingId,
        questionMessageId: older,
      });
      expect(await actions.consumePendingAction(ctx.org, ctx.conv, yes)).toBeNull();

      await actions.setPendingAction({
        organizationId: ctx.org,
        conversationId: ctx.conv,
        action: "cancel",
        bookingId,
        questionMessageId: newest,
      });
      expect((await actions.consumePendingAction(ctx.org, ctx.conv, yes))?.bookingId).toBe(bookingId);
    });

    it("el id de la pendiente es el del mensaje de la pregunta que vio el cliente", async () => {
      const ctx = await seed();
      await addBooking(ctx, slotAt(3, "10:00"));
      await cancelQuestion(ctx);
      expect((await pending(ctx))?.id).toBe((await lastOutbound(ctx)).id);
    });

    it.each([
      ["menor", "msg_0000"],
      ["mayor", "msg_zzzz"],
    ])("dos salientes con el MISMO instante (el otro con id %s) → no ejecutable", async (_label, prefix) => {
      const ctx = await seed();
      const bookingId = await addBooking(ctx, slotAt(3, "10:00"));
      const actions = await import("@/server/agenda/pending-actions");
      const at = new Date();
      const question = `msg_mmmm${ctx.conv}`;
      await addMessage(ctx, "out", "¿Confirmas que quieres cancelar tu cita?", { id: question, createdAt: at });
      await addMessage(ctx, "out", "Mensaje del operador", { id: `${prefix}${ctx.conv}`, createdAt: at });
      const yes = `msg_pgyes${ctx.conv}`;
      await addMessage(ctx, "in", "sí", { id: yes, createdAt: new Date(at.getTime() + 5) });
      await actions.setPendingAction({
        organizationId: ctx.org,
        conversationId: ctx.conv,
        action: "cancel",
        bookingId,
        questionMessageId: question,
      });
      expect(await actions.consumePendingAction(ctx.org, ctx.conv, yes)).toBeNull();
    });

    it("control: el otro saliente un milisegundo ANTES → la pregunta es la última y es ejecutable", async () => {
      const ctx = await seed();
      const bookingId = await addBooking(ctx, slotAt(3, "10:00"));
      const actions = await import("@/server/agenda/pending-actions");
      const at = new Date();
      const question = `msg_mmmm${ctx.conv}`;
      await addMessage(ctx, "out", "Mensaje del operador", { id: `msg_zzzz${ctx.conv}`, createdAt: new Date(at.getTime() - 1) });
      await addMessage(ctx, "out", "¿Confirmas que quieres cancelar tu cita?", { id: question, createdAt: at });
      const yes = `msg_pgyes${ctx.conv}`;
      await addMessage(ctx, "in", "sí", { id: yes, createdAt: new Date(at.getTime() + 5) });
      await actions.setPendingAction({
        organizationId: ctx.org,
        conversationId: ctx.conv,
        action: "cancel",
        bookingId,
        questionMessageId: question,
      });
      expect((await actions.consumePendingAction(ctx.org, ctx.conv, yes))?.bookingId).toBe(bookingId);
    });

    it("flujo completo: un operador escribe en el mismo instante que la pregunta → el 'sí' no cancela", async () => {
      const ctx = await seed();
      await addBooking(ctx, slotAt(3, "10:00"));
      await cancelQuestion(ctx);
      const question = await lastOutbound(ctx);
      // Postgres guarda microsegundos y JS milisegundos: se fija el mismo
      // instante exacto en los dos mensajes.
      const { d, s } = await db();
      const { eq } = await import("drizzle-orm");
      await d.update(s.message).set({ createdAt: question.createdAt }).where(eq(s.message.id, question.id));
      await addMessage(ctx, "out", "¿Te mando la ubicación?", {
        id: `msg_0000${ctx.conv}`,
        createdAt: question.createdAt,
      });
      await turn(ctx, "sí");
      expect((await bookings(ctx))[0]!.status).toBe("agendada");
    });
  });

  describe("consumePendingAction en SQL", () => {
    it("20 consumos concurrentes → una sola fila; sin ligar al último saliente → null", async () => {
      const ctx = await seed();
      const bookingId = await addBooking(ctx, slotAt(3, "10:00"));
      const actions = await import("@/server/agenda/pending-actions");
      const { d, s } = await db();
      const { and, desc, eq } = await import("drizzle-orm");
      const lastOut = async () =>
        (
          await d
            .select({ id: s.message.id })
            .from(s.message)
            .where(and(eq(s.message.conversationId, ctx.conv), eq(s.message.direction, "out")))
            .orderBy(desc(s.message.createdAt))
            .limit(1)
        )[0]!.id;

      for (let round = 0; round < 5; round++) {
        await addMessage(ctx, "out", `¿Confirmas? ${round}`);
        await actions.setPendingAction({
          organizationId: ctx.org,
          conversationId: ctx.conv,
          action: "cancel",
          bookingId,
          questionMessageId: await lastOut(),
        });
        const yes = `msg_pgyes${round}${ctx.conv}`;
        await addMessage(ctx, "in", "sí", { id: yes });
        const got = await Promise.all(
          Array.from({ length: 20 }, () => actions.consumePendingAction(ctx.org, ctx.conv, yes))
        );
        expect(got.filter(Boolean)).toHaveLength(1);
      }

      await addMessage(ctx, "out", "¿Confirmas?");
      await actions.setPendingAction({
        organizationId: ctx.org,
        conversationId: ctx.conv,
        action: "cancel",
        bookingId,
        questionMessageId: await lastOut(),
      });
      await addMessage(ctx, "out", "Mensaje de un operador");
      await addMessage(ctx, "in", "sí", { id: `msg_pgyesop${ctx.conv}` });
      expect(await actions.consumePendingAction(ctx.org, ctx.conv, `msg_pgyesop${ctx.conv}`)).toBeNull();

      await addMessage(ctx, "out", "¿Confirmas?");
      await actions.setPendingAction({
        organizationId: ctx.org,
        conversationId: ctx.conv,
        action: "cancel",
        questionMessageId: await lastOut(),
      });
      // Cancelar sin bookingId nunca es ejecutable.
      await addMessage(ctx, "in", "sí", { id: `msg_pgyesnb${ctx.conv}` });
      expect(await actions.consumePendingAction(ctx.org, ctx.conv, `msg_pgyesnb${ctx.conv}`)).toBeNull();
    });
  });
  /**
   * Correcciones de la revisión independiente sobre f765ecd (Postgres real).
   */
  describe("revisión f765ecd: orden del 'sí', fallos, cambio de cita y pausa", { timeout: 30_000 }, () => {
    const raw = async () => (await import("@/lib/db")).getSql();

    async function lastOutRow(ctx: Ctx) {
      const sql = await raw();
      const rows = await sql<{ id: string }[]>`
        select id from message where conversation_id = ${ctx.conv} and direction = 'out'
        order by created_at desc, id desc limit 1`;
      return rows[0]!.id;
    }

    async function conversationRow(ctx: Ctx) {
      const sql = await raw();
      const rows = await sql<{ handoff_reason: string | null; ai_enabled: boolean }[]>`
        select handoff_reason, ai_enabled from conversation where id = ${ctx.conv}`;
      return rows[0]!;
    }

    /** Corre un turno sobre los mensajes ya guardados (como el job de la cola). */
    async function runTurn(ctx: Ctx, model?: Record<string, unknown>) {
      h.modelData = model ?? { action: "reply", text: "Respuesta del modelo." };
      h.modelCalls = 0;
      const before = (await outbound(ctx)).length;
      const { runAgentTurn } = await import("@/server/ai/pipeline");
      await runAgentTurn(ctx.conv, ctx.org);
      await pause();
      return (await outbound(ctx)).slice(before);
    }

    describe("B-1: un 'sí' solo contesta a la pregunta si llegó DESPUÉS de ella", () => {
      it("un 'sí' guardado ANTES de la pregunta (aunque sea el último entrante) no cancela", async () => {
        const ctx = await seed();
        await addBooking(ctx, slotAt(3, "10:00"));
        await cancelQuestion(ctx);
        const question = await lastOutRow(ctx);
        const sql = await raw();
        await sql`
          insert into message (id, organization_id, conversation_id, direction, type, text, status, created_at)
          select ${`msg_pgearly${ctx.conv}`}, organization_id, conversation_id, 'in', 'text', 'sí', 'delivered',
                 created_at - interval '1 microsecond'
          from message where id = ${question}`;
        // El 'sí' es el entrante más reciente (no hay otro), pero es anterior a la pregunta.
        await runTurn(ctx);
        expect((await bookings(ctx))[0]!.status).toBe("agendada");
        expect(await pending(ctx)).toBeNull();
      });

      it("un 'sí' con el MISMO instante que la pregunta no cancela", async () => {
        const ctx = await seed();
        await addBooking(ctx, slotAt(3, "10:00"));
        await cancelQuestion(ctx);
        const question = await lastOutRow(ctx);
        const sql = await raw();
        await sql`
          insert into message (id, organization_id, conversation_id, direction, type, text, status, created_at)
          select ${`msg_pgtie${ctx.conv}`}, organization_id, conversation_id, 'in', 'text', 'sí', 'delivered', created_at
          from message where id = ${question}`;
        await runTurn(ctx);
        expect((await bookings(ctx))[0]!.status).toBe("agendada");
      });

      it("flujo de la revisión con el turno RETENIDO: el 'sí' al operador, guardado antes de la pregunta, no cancela; un 'sí' después, sí", async () => {
        const ctx = await seed();
        await addBooking(ctx, slotAt(3, "10:00"));
        await addMessage(ctx, "out", "Hola, soy Laura. ¿Te mando la ubicación del local?", { origin: "operator" });
        await addMessage(ctx, "in", "cancela mi cita");

        // Otra transacción retiene la tabla booking: el turno que crea la
        // pregunta queda en curso mientras llega el "sí" del cliente.
        const sql = await raw();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let locked!: () => void;
        const lockTaken = new Promise<void>((resolve) => (locked = resolve));
        const lockTx = sql.begin(async (tx) => {
          await tx`lock table booking in access exclusive mode`;
          locked();
          await gate;
        });
        await lockTaken;
        const { runAgentTurn } = await import("@/server/ai/pipeline");
        const job1 = runAgentTurn(ctx.conv, ctx.org);
        await new Promise((resolve) => setTimeout(resolve, 400));
        await addMessage(ctx, "in", "sí"); // contesta al operador
        release();
        await lockTx;
        await job1;

        const order = await sql<{ direction: string; text: string }[]>`
          select direction, text from message where conversation_id = ${ctx.conv} order by created_at`;
        expect(order.map((m) => `${m.direction}:${m.text.slice(0, 18)}`)).toEqual([
          "out:Hola, soy Laura. ¿",
          "in:cancela mi cita",
          "in:sí",
          "out:Antes de cancelar ",
        ]);
        expect((await pending(ctx))?.action).toBe("cancel");

        // El job reprogramado procesa ese "sí": no cancela.
        await runTurn(ctx);
        expect((await bookings(ctx))[0]!.status).toBe("agendada");

        // Vida: la pregunta se repite y un "sí" posterior sí cancela.
        await cancelQuestion(ctx);
        await turn(ctx, "sí");
        expect((await bookings(ctx))[0]!.status).toBe("cancelada");
      });

      it("SQL directo: el entrante debe ser de la conversación, entrante y posterior a la pregunta", async () => {
        const ctx = await seed();
        const other = await seed();
        const bookingId = await addBooking(ctx, slotAt(3, "10:00"));
        const actions = await import("@/server/agenda/pending-actions");
        await addMessage(ctx, "in", "sí (antes)", { id: `msg_pgbefore${ctx.conv}` });
        await addMessage(ctx, "out", "¿Confirmas?");
        const question = await lastOutRow(ctx);
        await addMessage(ctx, "in", "sí (después)", { id: `msg_pgafter${ctx.conv}` });
        await addMessage(other, "in", "sí (otra conversación)", { id: `msg_pgother${other.conv}` });
        const set = () =>
          actions.setPendingAction({
            organizationId: ctx.org,
            conversationId: ctx.conv,
            action: "cancel",
            bookingId,
            questionMessageId: question,
          });
        await set();
        expect(await actions.consumePendingAction(ctx.org, ctx.conv, `msg_pgbefore${ctx.conv}`)).toBeNull();
        expect(await actions.consumePendingAction(ctx.org, ctx.conv, `msg_pgother${other.conv}`)).toBeNull();
        expect(await actions.consumePendingAction(ctx.org, ctx.conv, question)).toBeNull(); // un saliente no es un "sí"
        expect((await actions.consumePendingAction(ctx.org, ctx.conv, `msg_pgafter${ctx.conv}`))?.bookingId).toBe(bookingId);
      });
    });

    describe("B-2: reprogramar con slot_taken ofrece alternativas y vuelve a preguntar", () => {
      it("el horario se ocupa antes del 'sí' → alternativas; elegir otra → pregunta → 'sí' mueve la MISMA cita", async () => {
        const ctx = await seed();
        const id = await addBooking(ctx, slotAt(3, "10:00"));
        await showOffer(
          ctx,
          [
            { startUtc: slotAt(4, "11:00"), label: "11:00" },
            { startUtc: slotAt(4, "12:00"), label: "12:00" },
          ],
          "quiero cambiar mi cita"
        );
        await turn(ctx, "11:00");
        expect((await pending(ctx))?.action).toBe("reschedule");
        h.available = [{ startUtc: slotAt(4, "12:00"), label: "12:00" }]; // las 11:00 se ocuparon

        const replies = await turn(ctx, "sí");
        expect(replies.at(-1)).toContain("Ese horario ya no está disponible para mover tu cita. Elige otro:");
        expect(replies.at(-1)).toContain("12:00");
        expect((await bookings(ctx))[0]!.at.toISOString()).toBe(slotAt(3, "10:00"));
        expect((await conversationRow(ctx)).handoff_reason).toBeNull();

        const question = await turn(ctx, "12:00");
        expect(question.at(-1)).toMatch(/Tu cita actual: .*10:00.*12:00.*¿Confirmas que mueva tu cita/s);
        await turn(ctx, "sí");
        const after = await bookings(ctx);
        expect(after).toHaveLength(1);
        expect(after[0]!.id).toBe(id);
        expect(after[0]!.at.toISOString()).toBe(slotAt(4, "12:00"));
      });
    });

    describe("B-3: en medio de un cambio de cita, book_slot del modelo mueve, no crea otra", () => {
      it("'quiero cambiar mi cita' → oferta → 'quiero las 11' [book_slot] → pregunta de mover → 'sí'", async () => {
        const ctx = await seed();
        const id = await addBooking(ctx, slotAt(3, "10:00"));
        await showOffer(ctx, [{ startUtc: slotAt(4, "11:00"), label: "11:00" }], "quiero cambiar mi cita");
        const question = await turn(ctx, "quiero las 11", { action: "book_slot", startUtc: slotAt(4, "11:00") });
        expect(question.at(-1)).toMatch(/Tu cita actual: .*¿Confirmas que mueva tu cita a ese horario\?/);
        const p = await pending(ctx);
        expect(p?.action).toBe("reschedule");
        expect(p?.bookingId).toBe(id);

        await turn(ctx, "sí");
        const after = await bookings(ctx);
        expect(after).toHaveLength(1);
        expect(after[0]!.id).toBe(id);
        expect(after[0]!.at.toISOString()).toBe(slotAt(4, "11:00"));
      });
    });

    describe("F2 / F4: un error de BD al ejecutar responde y hace handoff, sin relanzar", () => {
      beforeAll(async () => {
        const sql = await raw();
        await sql.unsafe(`
          create table if not exists test_booking_failure (conversation_id text not null, op text not null);
          create or replace function test_booking_failure_fn() returns trigger language plpgsql as $f$
          begin
            if exists (select 1 from test_booking_failure f where f.conversation_id = NEW.conversation_id and f.op = TG_OP) then
              raise exception 'fallo de BD simulado en % de booking', TG_OP;
            end if;
            return NEW;
          end $f$;
          drop trigger if exists test_booking_failure_trg on booking;
          create trigger test_booking_failure_trg before insert or update on booking
            for each row execute function test_booking_failure_fn();
        `);
      });

      afterAll(async () => {
        const sql = await raw();
        await sql.unsafe(`
          drop trigger if exists test_booking_failure_trg on booking;
          drop function if exists test_booking_failure_fn();
          drop table if exists test_booking_failure;
        `);
      });

      async function failOn(ctx: Ctx, op: "INSERT" | "UPDATE") {
        const sql = await raw();
        await sql`insert into test_booking_failure values (${ctx.conv}, ${op})`;
      }

      it("F2: mover falla en la BD → mensaje determinista + handoff; el reintento no hace improvisar al modelo", async () => {
        const ctx = await seed();
        await addBooking(ctx, slotAt(3, "10:00"));
        await showOffer(ctx, [{ startUtc: slotAt(4, "11:00"), label: "11:00" }], "quiero cambiar mi cita");
        await turn(ctx, "11:00");
        await failOn(ctx, "UPDATE");

        const replies = await turn(ctx, "sí", { action: "reply", text: "¡Listo!" });
        expect(replies).toEqual(["No pude mover tu cita automáticamente. Un asesor continuará contigo."]);
        expect((await conversationRow(ctx)).handoff_reason).toBe("error");
        expect((await bookings(ctx))[0]!.at.toISOString()).toBe(slotAt(3, "10:00"));

        // Si el job se repitiera: con el handoff la IA no responde nada más.
        const retry = await runTurn(ctx, { action: "reply", text: "¡Listo!" });
        expect(retry).toEqual([]);
        expect(h.modelCalls).toBe(0);
      });

      it("F4: agendar falla en la BD (tono usted) → mensaje determinista + handoff, sin cita", async () => {
        const ctx = await seed("usted");
        const slots = [{ startUtc: slotAt(2, "16:00"), label: "16:00" }];
        await showOffer(ctx, slots);
        await turn(ctx, "a las 4");
        expect((await pending(ctx))?.action).toBe("book");
        await failOn(ctx, "INSERT");

        const replies = await turn(ctx, "sí", { action: "reply", text: "¡Listo!" });
        expect(replies).toEqual(["No pude agendar su cita automáticamente. Un asesor continuará con usted."]);
        expect((await conversationRow(ctx)).handoff_reason).toBe("error");
        expect(await bookings(ctx)).toHaveLength(0);
        expect(await runTurn(ctx, { action: "reply", text: "¡Listo!" })).toEqual([]);
      });
    });

    describe("pausar y reanudar la IA invalida la pendiente", () => {
      it("pausa y reanuda sin escribir → el 'sí' no cancela", async () => {
        const ctx = await seed();
        await addBooking(ctx, slotAt(3, "10:00"));
        await cancelQuestion(ctx);
        const { updateConversation } = await import("@/server/inbox/queries");
        await updateConversation(ctx.org, ctx.conv, { aiEnabled: false });
        await updateConversation(ctx.org, ctx.conv, { aiEnabled: true });
        expect(await pending(ctx)).toBeNull();
        await turn(ctx, "sí");
        expect((await bookings(ctx))[0]!.status).toBe("agendada");
      });

      it("un 'sí' mientras la IA está en pausa no hace nada, y tras reanudar otro 'sí' tampoco", async () => {
        const ctx = await seed();
        await addBooking(ctx, slotAt(3, "10:00"));
        await cancelQuestion(ctx);
        const { updateConversation } = await import("@/server/inbox/queries");
        await updateConversation(ctx.org, ctx.conv, { aiEnabled: false });
        expect(await turn(ctx, "sí")).toEqual([]);
        await updateConversation(ctx.org, ctx.conv, { aiEnabled: true });
        await turn(ctx, "sí");
        expect((await bookings(ctx))[0]!.status).toBe("agendada");
      });

      it("SQL directo: con la IA apagada la pendiente no es ejecutable", async () => {
        const ctx = await seed();
        const bookingId = await addBooking(ctx, slotAt(3, "10:00"));
        const actions = await import("@/server/agenda/pending-actions");
        await addMessage(ctx, "out", "¿Confirmas?");
        const question = await lastOutRow(ctx);
        await addMessage(ctx, "in", "sí", { id: `msg_pgpaused${ctx.conv}` });
        await actions.setPendingAction({
          organizationId: ctx.org,
          conversationId: ctx.conv,
          action: "cancel",
          bookingId,
          questionMessageId: question,
        });
        const sql = await raw();
        await sql`update conversation set ai_enabled = false where id = ${ctx.conv}`;
        expect(await actions.consumePendingAction(ctx.org, ctx.conv, `msg_pgpaused${ctx.conv}`)).toBeNull();
      });
    });
  });
});
