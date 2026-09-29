import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Paquete Agenda / IA — segunda parte:
 *   IA-1  cancelación segura (pregunta ≠ orden; orden ⇒ confirmación pendiente)
 *   IA-W2 estado de confirmación pendiente (tenant-safe, con expiración)
 *   QB-02/IA-W5  semántica de ocupación aprobada
 *   QB-08 fallback de horario del negocio
 *   QB-09 cierre a medianoche (24:00)
 *   QB-10 timezone efectiva del booking
 *   QB-12 refreshOffer preserva contexto
 */

const h = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  inserts: [] as { table: unknown; values: Record<string, unknown> }[],
  deletes: 0,
}));

function thenableChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit", "orderBy"]) chain[m] = () => chain;
  (chain as { then: unknown }).then = (res: (v: unknown) => void) =>
    Promise.resolve(rows).then(res);
  return chain;
}

const fakeDb = {
  select: () => thenableChain(h.selectQueue.shift() ?? []),
  insert: () => ({
    values: (values: Record<string, unknown>) => {
      h.inserts.push({ table: "pending", values });
      const chain: Record<string, unknown> = {};
      chain.onConflictDoUpdate = () => Promise.resolve([]);
      (chain as { then: unknown }).then = (res: (v: unknown) => void) =>
        Promise.resolve([]).then(res);
      return chain;
    },
  }),
  delete: () => ({
    where: () => {
      h.deletes += 1;
      return Promise.resolve([]);
    },
  }),
};

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return { ...original, getDb: () => fakeDb };
});

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

beforeEach(() => {
  h.selectQueue.length = 0;
  h.inserts.length = 0;
  h.deletes = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
// IA-1 · pregunta vs orden
// ─────────────────────────────────────────────────────────────────────────────

describe("IA-1 — una pregunta sobre cancelar NO es una orden", () => {
  it("las frases informativas no disparan cancelación", async () => {
    const { matchesCancellationIntent } = await import(
      "@/server/agenda/cancel-intent"
    );

    for (const text of [
      "¿Puedo cancelar mi cita?",
      "¿Puedo cancelar mi cita si me surge algo?",
      "¿Cuánto cobran si cancelo mi cita?",
      "¿Se puede cancelar?",
      "¿Qué pasa si cancelo mi cita?",
      "si cancelo mi cita, ¿me cobran?",
      "¿hay alguna penalización si cancelo mi reserva?",
    ]) {
      expect({ text, intent: matchesCancellationIntent(text) }).toMatchObject({
        intent: false,
      });
    }
  });

  it("las órdenes imperativas sí la disparan (para pedir confirmación)", async () => {
    const { matchesCancellationIntent } = await import(
      "@/server/agenda/cancel-intent"
    );

    expect(matchesCancellationIntent("cancela mi cita")).toBe(true);
    expect(matchesCancellationIntent("quiero cancelar")).toBe(true);
    expect(matchesCancellationIntent("cancela mi reserva")).toBe(true);
    expect(matchesCancellationIntent("cancélala")).toBe(true);
    expect(matchesCancellationIntent("anula mi cita")).toBe(true);
  });

  it("la pregunta se identifica como informativa", async () => {
    const { isCancellationQuestion } = await import(
      "@/server/agenda/cancel-intent"
    );

    expect(isCancellationQuestion("¿Puedo cancelar mi cita?")).toBe(true);
    expect(isCancellationQuestion("cancela mi cita")).toBe(false);
    expect(isCancellationQuestion("hola")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IA-W2 · confirmación
// ─────────────────────────────────────────────────────────────────────────────

describe("IA-W2 — detección de confirmación inequívoca", () => {
  it("acepta confirmaciones cortas", async () => {
    const { isAffirmativeConfirmation } = await import(
      "@/server/agenda/selection"
    );

    for (const text of [
      "sí",
      "Si",
      "sí, cancélala",
      "sí, agéndala",
      "confirmo",
      "dale",
      "ok",
    ]) {
      expect({ text, ok: isAffirmativeConfirmation(text) }).toMatchObject({
        ok: true,
      });
    }
  });

  it("rechaza condicionales y mensajes largos", async () => {
    const { isAffirmativeConfirmation } = await import(
      "@/server/agenda/selection"
    );

    for (const text of [
      "si me surge algo te aviso",
      "sí, pero primero dime cuánto cuesta cancelar mi cita",
      "no",
      "gracias",
      "hola",
    ]) {
      expect({ text, ok: isAffirmativeConfirmation(text) }).toMatchObject({
        ok: false,
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IA-W2 · estado pendiente
// ─────────────────────────────────────────────────────────────────────────────

describe("IA-W2 — estado de confirmación pendiente", () => {
  it("guarda una sola acción por conversación (la última gana)", async () => {
    const { setPendingAction } = await import("@/server/agenda/pending-actions");

    await setPendingAction({
      organizationId: "org_a",
      conversationId: "cv_1",
      action: "cancel",
    });

    expect(h.inserts).toHaveLength(1);
    const values = h.inserts[0]!.values;
    expect(values.action).toBe("cancel");
    expect(values.organizationId).toBe("org_a");
    expect(values.conversationId).toBe("cv_1");
    expect(values.expiresAt).toBeInstanceOf(Date);
  });

  it("no devuelve una acción expirada (y la borra)", async () => {
    const { getPendingAction } = await import("@/server/agenda/pending-actions");

    h.selectQueue.push([
      {
        id: "paa_1",
        action: "cancel",
        bookingId: null,
        startUtc: null,
        serviceId: null,
        professionalId: null,
        expiresAt: new Date(Date.now() - 1000),
      },
    ]);

    await expect(getPendingAction("org_a", "cv_1")).resolves.toBeNull();
    expect(h.deletes).toBe(1);
  });

  it("devuelve la acción vigente con su contexto", async () => {
    const { getPendingAction } = await import("@/server/agenda/pending-actions");

    h.selectQueue.push([
      {
        id: "paa_2",
        action: "reschedule",
        bookingId: "bk_1",
        startUtc: new Date("2026-09-16T15:00:00.000Z"),
        serviceId: "svc_1",
        professionalId: "pro_1",
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);

    const pending = await getPendingAction("org_a", "cv_1");
    expect(pending).toMatchObject({
      action: "reschedule",
      bookingId: "bk_1",
      startUtc: "2026-09-16T15:00:00.000Z",
      serviceId: "svc_1",
      professionalId: "pro_1",
    });
  });

  it("la migración 0030 es tenant-safe y con expiración", () => {
    const sql = source("drizzle/0030_pending_agenda_action.sql");

    expect(sql).toContain('"organization_id" text NOT NULL');
    expect(sql).toContain('"expires_at" timestamp NOT NULL');
    expect(sql).toContain("pending_agenda_action_conversation_uq");
    expect(sql).toContain("CHECK (\"action\" IN ('book', 'reschedule', 'cancel'))");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IA-1 / IA-W1 · cableado del pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe("IA-1 / IA-W1 — el pipeline no cancela ni mueve sin confirmación", () => {
  const pipeline = source("src/server/ai/pipeline.ts");

  it("la cancelación imperativa abre confirmación pendiente en vez de cancelar", () => {
    expect(pipeline).toContain("await setPendingAction({");
    expect(pipeline).toContain('action: "cancel"');
    expect(pipeline).toContain("Antes de cancelar necesito tu confirmación");
    // La orden ya no llama a handleCancellation directamente.
    expect(pipeline).not.toMatch(
      /matchesCancellationIntent\(inboundText\)\) \{\s*await handleCancellation/
    );
  });

  it("la confirmación ejecuta SOLO el pending vigente", () => {
    expect(pipeline).toContain("await getPendingAction(organizationId, conversationId)");
    expect(pipeline).toContain("await clearPendingAction(organizationId, conversationId)");
    expect(pipeline).toContain('pending.action === "cancel"');
    expect(pipeline).toContain('pending.action === "book"');
    expect(pipeline).toContain('pending.action === "reschedule"');
  });

  it("una selección de horario deja pending y no reserva ni mueve", () => {
    expect(pipeline).toContain('action: "book",');
    expect(pipeline).toContain('action: "reschedule",');
    expect(pipeline).toContain("¿Confirmas que mueva tu cita a ese horario?");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QB-02 / QB-08 / QB-09 / QB-10 / QB-12
// ─────────────────────────────────────────────────────────────────────────────

describe("QB-02 / IA-W5 — semántica de ocupación aprobada", () => {
  const availability = source("src/server/agenda/professional-availability.ts");

  it("la disponibilidad profesional resta lo suyo y lo GENERAL (bloqueos y citas sin profesional)", () => {
    expect(availability).toContain("isNull(schema.booking.professionalId)");
    expect(availability).toContain("or(");
    expect(availability).toContain("eq(schema.booking.professionalId, input.professionalId)");
  });

  it("el camino general sigue contando toda la ocupación de la organización", () => {
    const general = source("src/server/agenda/availability.ts");
    expect(general).toContain('inArray(schema.booking.status, ["agendada", "realizada"])');
    expect(general).not.toContain("professionalId");
  });
});

describe("QB-08 — fallback al horario del negocio", () => {
  it("sin horario propio del profesional se hereda el del negocio", () => {
    const availability = source("src/server/agenda/professional-availability.ts");

    expect(availability).toContain(
      "Object.keys(weeklyHours).length > 0 ? weeklyHours : baseSettings.weeklyHours"
    );
  });
});

describe("QB-09 — cierre a medianoche", () => {
  it("24:00 es un fin válido y se resuelve al día siguiente", async () => {
    const { isValidInterval, zonedWallClockToUtc } = await import(
      "@/lib/time/slots"
    );

    expect(isValidInterval({ start: "09:00", end: "24:00" })).toBe(true);
    expect(isValidInterval({ start: "00:00", end: "24:00" })).toBe(true);
    // 24:00 nunca es un inicio válido.
    expect(isValidInterval({ start: "24:00", end: "24:00" })).toBe(false);

    const end = zonedWallClockToUtc("2026-09-16", "24:00", "UTC");
    expect(end?.toISOString()).toBe("2026-09-17T00:00:00.000Z");
  });

  it("un día 09:00–24:00 produce huecos (no se descarta en silencio)", async () => {
    const { expandWorkingDayToUtc } = await import("@/lib/time/slots");

    const slots = expandWorkingDayToUtc(
      "2026-09-16",
      [{ start: "09:00", end: "24:00" }],
      "UTC",
      60,
      0
    );
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.at(-1)!.startUtc).toBe("2026-09-16T23:00:00.000Z");
  });
});

describe("QB-10 / QB-12 — timezone efectiva y contexto de la oferta", () => {
  const service = source("src/server/agenda/service.ts");

  it("la etiqueta y el evento usan la timezone PERSISTIDA de la cita", () => {
    expect(service).toContain("labelInTz(slot.startUtc, delivered.timezone)");
    expect(service).toContain("timezone: booking.timezone,");
  });

  it("refreshOffer preserva servicio/profesional y no reescribe la oferta del operador", () => {
    expect(service).toContain("serviceId = opts.serviceId ?? existing[0]?.serviceId ?? null");
    expect(service).toContain("replace: input.requireOffer");
    expect(service).toContain("opts.replace !== false");
  });
});
