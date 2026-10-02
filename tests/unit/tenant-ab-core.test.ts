import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * Tenant A / Tenant B — conversación, respuesta, lead/pipeline, cita, media y
 * credenciales de WhatsApp.
 *
 * Cada operación real se ejecuta como ORG_A contra una base que no devuelve
 * filas; se captura el WHERE y se exige que esté ligado a ORG_A y jamás a
 * ORG_B. Si alguien quita `scoped(...)`, el WHERE pierde ORG_A y el test falla.
 */

const ORG_A = "org_A";
const ORG_B = "org_B";

const h = vi.hoisted(() => ({
  wheres: [] as unknown[],
  writes: 0,
  selectRows: [] as unknown[],
}));

function chain(rows: unknown[], write = false) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "orderBy", "limit", "innerJoin", "leftJoin", "set"]) {
    c[m] = () => c;
  }
  c.where = (w: unknown) => {
    h.wheres.push(w);
    return c;
  };
  c.returning = () => Promise.resolve(rows);
  (c as { then: unknown }).then = (res: (v: unknown) => void) => {
    if (write) h.writes += 1;
    return Promise.resolve(rows).then(res);
  };
  return c;
}

const fakeDb = {
  select: () => chain(h.selectRows.length ? [h.selectRows.shift()] : []),
  update: () => chain([], true),
  delete: () => chain([], true),
  insert: () => ({ values: () => chain([], true) }),
  transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb),
};

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return { ...original, getDb: () => fakeDb };
});
vi.mock("@/server/agenda/settings", () => ({
  getSettings: async () => ({
    weeklyHours: {},
    slotMinutes: 30,
    bufferMinutes: 0,
    minNoticeHours: 0,
    maxDaysAhead: 14,
    timezone: "UTC",
    connector: "google",
    meetingLink: null,
    videoCall: true,
  }),
}));
vi.mock("@/server/events/bus", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/events/bus")>();
  return { ...original, publish: () => {} };
});

const dialect = new PgDialect();
const q = (w: unknown) => dialect.sqlToQuery(w as SQL);

function expectScopedToA(whereIndex = 0) {
  const { params } = q(h.wheres[whereIndex]);
  expect(params).toContain(ORG_A);
  expect(params).not.toContain(ORG_B);
}

beforeEach(() => {
  h.wheres.length = 0;
  h.writes = 0;
  h.selectRows.length = 0;
});

describe("1 · conversación", () => {
  it("A no puede leer una conversación de B", async () => {
    const { getConversation } = await import("@/server/inbox/queries");
    const row = await getConversation(ORG_A, "conv_of_B");
    expect(row).toBeNull();
    expectScopedToA();
  }, 30_000);

  it("A no puede modificar una conversación de B", async () => {
    const { updateConversation } = await import("@/server/inbox/queries");
    const res = await updateConversation(ORG_A, "conv_of_B", { markRead: true });
    expect(res).toBeFalsy();
    expectScopedToA();
  });

  it("A no puede responder una conversación de B: no envía ni persiste", async () => {
    const { sendText, SendError } = await import("@/server/inbox/send");
    await expect(
      sendText({
        conversationId: "conv_of_B",
        organizationId: ORG_A,
        text: "hola",
      })
    ).rejects.toBeInstanceOf(SendError);
    expectScopedToA();
    expect(h.writes).toBe(0);
  });
});

describe("2 · lead / pipeline", () => {
  it("A no puede mover un lead de B (ni a una etapa de B)", async () => {
    const { moveLeadToStage } = await import("@/server/leads/stage-history");
    const res = await moveLeadToStage({
      organizationId: ORG_A,
      leadId: "lead_of_B",
      toStageId: "stage_of_B",
      source: "dueno",
    });
    expect(res).toEqual({ ok: false, reason: "lead_not_found" });
    expectScopedToA();
    expect(h.writes).toBe(0);
  });
});

describe("3 · cita", () => {
  it("A no puede reprogramar una cita de B", async () => {
    const { rescheduleBooking, BookingError } = await import(
      "@/server/agenda/service"
    );
    await expect(
      rescheduleBooking({
        organizationId: ORG_A,
        bookingId: "booking_of_B",
        startUtc: "2030-01-01T10:00:00Z",
      })
    ).rejects.toBeInstanceOf(BookingError);
    expectScopedToA();
    expect(h.writes).toBe(0);
  });

  it("A no puede cancelar una cita de B", async () => {
    const { cancelBooking, BookingError } = await import(
      "@/server/agenda/service"
    );
    await expect(
      cancelBooking({ organizationId: ORG_A, bookingId: "booking_of_B" })
    ).rejects.toBeInstanceOf(BookingError);
    expectScopedToA();
    expect(h.writes).toBe(0);
  });

  it("A no puede marcar el resultado de una cita de B", async () => {
    const { markBookingStatus, BookingError } = await import(
      "@/server/agenda/service"
    );
    await expect(
      markBookingStatus({
        organizationId: ORG_A,
        bookingId: "booking_of_B",
        status: "realizada",
      })
    ).rejects.toBeInstanceOf(BookingError);
    expectScopedToA();
    expect(h.writes).toBe(0);
  });
});

describe("4 · media", () => {
  it("A no puede leer ni descargar el asset de B", async () => {
    const { ensureAssetAvailable, readMediaFile } = await import(
      "@/server/whatsapp/media"
    );
    // La consulta es por id; la pertenencia se comprueba sobre la fila. Aunque
    // la base DEVUELVA el asset de B, A recibe null y no hay descarga/escritura.
    h.selectRows.push({
      id: "asset_of_B",
      organizationId: ORG_B,
      fetchStatus: "pending",
      waMediaId: "wa_media_B",
    });
    expect(await ensureAssetAvailable(ORG_A, "asset_of_B")).toBeNull();
    expect(h.writes).toBe(0);
    // El archivo vive bajo el directorio del tenant: A no alcanza el de B.
    await expect(readMediaFile(ORG_A, "asset_of_B")).rejects.toBeDefined();
  });
});

describe("5 · credenciales WhatsApp", () => {
  it("A solo resuelve las credenciales de su propia organización", async () => {
    const { getCredentialsByOrg } = await import(
      "@/server/whatsapp/credentials"
    );
    expect(await getCredentialsByOrg(ORG_A)).toBeNull();
    expectScopedToA();
  });

  it("un organizationId vacío no degrada a consulta global", async () => {
    const { getCredentialsByOrg } = await import(
      "@/server/whatsapp/credentials"
    );
    await expect(getCredentialsByOrg("")).rejects.toThrow(/organizationId/);
  });

  it("phone_number_id es único en la instancia (el enrutamiento no es ambiguo)", async () => {
    const { metaCredentials } = await import("@/lib/db/schema");
    const { getTableConfig } = await import("drizzle-orm/pg-core");
    const idx = getTableConfig(metaCredentials).indexes.map((i) => ({
      name: i.config.name,
      unique: i.config.unique,
    }));
    expect(idx).toContainEqual({ name: "meta_credentials_phone_uq", unique: true });
    expect(idx).toContainEqual({ name: "meta_credentials_org_uq", unique: true });
  });
});
