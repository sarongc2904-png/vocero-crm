import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * API del bot de cotizaciones contra un Postgres REAL: rutas reales
 * (`/api/bot/catalog`, `/api/bot/quotes`, `/api/bot/quotes/:id`), API keys
 * reales por negocio (`issueBotApiKey`) y la migración 0037 aplicada.
 *
 * Lo que fija:
 *  - el negocio sale SOLO de la API key; todo id de otro negocio es 404;
 *  - el precio sale de la base, el body no acepta montos;
 *  - con la bandera apagada nada existe (404) y nada se escribe.
 *
 * Opcional: corre solo con `VOCERO_TEST_PG_URL` apuntando a una base
 * DESCARTABLE con las migraciones aplicadas. Sin la variable se omite.
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
});

type Tenant = {
  org: string;
  key: string;
  contact: string;
  conv: string;
  labConv: string;
  lead: string;
  svc: string; // $1,500.00
  svc2: string; // $99.95
  inactive: string;
  usd: string;
};

let seq = 0;
const created: string[] = [];

async function db() {
  const { getDb, schema } = await import("@/lib/db");
  return { d: getDb(), s: schema };
}

async function seedTenant(): Promise<Tenant> {
  const { d, s } = await db();
  const { issueBotApiKey } = await import("@/server/bot/api-keys");
  seq += 1;
  const tag = `${Date.now().toString(36)}${seq}`;
  const t: Omit<Tenant, "key" | "lead"> = {
    org: `org_qb${tag}`,
    contact: `ct_qb${tag}`,
    conv: `cv_qb${tag}`,
    labConv: `cv_qbl${tag}`,
    svc: `svc_qb${tag}`,
    svc2: `svc_qb2${tag}`,
    inactive: `svc_qbi${tag}`,
    usd: `svc_qbu${tag}`,
  };
  created.push(t.org);
  await d.insert(s.organization).values({ id: t.org, name: `Org ${tag}` });
  await d.insert(s.contact).values({ id: t.contact, organizationId: t.org, waIdentity: `52155${tag}`, name: "Cliente" });
  await d.insert(s.conversation).values([
    { id: t.conv, organizationId: t.org, contactId: t.contact },
  ]);
  const labContact = `ct_qbl${tag}`;
  await d.insert(s.contact).values({ id: labContact, organizationId: t.org, waIdentity: `52166${tag}`, name: "Lab" });
  await d.insert(s.conversation).values({ id: t.labConv, organizationId: t.org, contactId: labContact, isTest: true });
  const stage = `stg_qb${tag}`;
  await d.insert(s.pipelineStage).values({ id: stage, organizationId: t.org, name: "Nuevo", position: 0 });
  const lead = `ld_qb${tag}`;
  await d.insert(s.lead).values({ id: lead, organizationId: t.org, contactId: t.contact, stageId: stage });
  await d.insert(s.service).values([
    { id: t.svc, organizationId: t.org, name: `Instalación ${tag}`, durationMinutes: 60, priceCents: 150000 },
    { id: t.svc2, organizationId: t.org, name: `Material ${tag}`, durationMinutes: 30, priceCents: 9995 },
    { id: t.inactive, organizationId: t.org, name: `Retirado ${tag}`, durationMinutes: 30, priceCents: 100, active: false },
    { id: t.usd, organizationId: t.org, name: `Importado ${tag}`, durationMinutes: 30, priceCents: 5000, currency: "USD" },
  ]);
  const { key } = await issueBotApiKey(t.org);
  return { ...t, key, lead };
}

function req(path: string, key: string | null, init: { method?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["x-api-key"] = key;
  return new Request(`http://localhost:3000${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function routes() {
  const catalog = await import("@/app/api/bot/catalog/route");
  const quotes = await import("@/app/api/bot/quotes/route");
  const one = await import("@/app/api/bot/quotes/[id]/route");
  return {
    catalog: (key: string | null) => catalog.GET(req("/api/bot/catalog", key)),
    create: (key: string | null, body: unknown) => quotes.POST(req("/api/bot/quotes", key, { method: "POST", body })),
    list: (key: string | null, qs = "") => quotes.GET(req(`/api/bot/quotes${qs}`, key)),
    get: (key: string | null, id: string) =>
      one.GET(req(`/api/bot/quotes/${id}`, key), { params: Promise.resolve({ id }) }),
  };
}

async function quoteCount(org: string): Promise<number> {
  const { d, s } = await db();
  const { eq, count } = await import("drizzle-orm");
  const rows = await d.select({ n: count() }).from(s.quote).where(eq(s.quote.organizationId, org));
  return Number(rows[0]?.n ?? 0);
}

let a: Tenant;
let b: Tenant;

describe.skipIf(!PG_URL)("API del bot de cotizaciones (Postgres real)", () => {
  beforeAll(async () => {
    vi.stubEnv("COTIZACIONES", "on");
    a = await seedTenant();
    b = await seedTenant();
  });

  afterEach(() => {
    vi.stubEnv("COTIZACIONES", "on");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (created.length === 0) return;
    const { d, s } = await db();
    const { inArray } = await import("drizzle-orm");
    await d.delete(s.organization).where(inArray(s.organization.id, created));
  });

  it("con la bandera apagada todo es 404, incluso con una key válida, y nada se escribe", async () => {
    vi.stubEnv("COTIZACIONES", "");
    const r = await routes();
    const before = await quoteCount(a.org);
    for (const res of [
      await r.catalog(a.key),
      await r.create(a.key, { conversationId: a.conv, items: [{ serviceId: a.svc }] }),
      await r.list(a.key),
      await r.get(a.key, "qt_cualquiera"),
    ]) {
      expect(res.status).toBe(404);
    }
    expect(await quoteCount(a.org)).toBe(before);
  });

  it("sin key o con una key inválida responde 401", async () => {
    const r = await routes();
    expect((await r.catalog(null)).status).toBe(401);
    expect((await r.catalog("no-es-una-key")).status).toBe(401);
    expect((await r.create("no-es-una-key", { conversationId: a.conv, items: [{ serviceId: a.svc }] })).status).toBe(401);
  });

  it("el catálogo trae solo servicios activos del negocio de la key, con IVA por defecto 16 % sumado", async () => {
    const r = await routes();
    const res = await r.catalog(a.key);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { services: { id: string; priceCents: number }[]; tax: unknown };
    const ids = body.services.map((svc) => svc.id).sort();
    expect(ids).toEqual([a.svc, a.svc2, a.usd].sort());
    expect(ids).not.toContain(a.inactive);
    for (const id of [b.svc, b.svc2, b.usd]) expect(ids).not.toContain(id);
    expect(body.tax).toEqual({ pricesIncludeTax: false, taxRateBps: 1600 });
  });

  it("crea un borrador con precios de la base y totales del servidor", async () => {
    const r = await routes();
    const res = await r.create(a.key, {
      conversationId: a.conv,
      items: [
        { serviceId: a.svc, quantity: 2 },
        { serviceId: a.svc2, quantity: 1.5 },
      ],
      notes: "Incluye visita",
    });
    expect(res.status).toBe(201);
    const { quote } = (await res.json()) as { quote: Record<string, unknown> & { items: Record<string, unknown>[] } };
    expect(quote).toMatchObject({
      folio: "COT-0001",
      status: "borrador",
      conversationId: a.conv,
      contactId: a.contact,
      currency: "MXN",
      pricesIncludeTax: false,
      taxRateBps: 1600,
      // 2 × 1500.00 = 3000.00; 1.5 × 99.95 = 149.925 → 149.93 (half-up por línea)
      subtotalCents: 314993,
      // IVA una vez: 3149.93 × 0.16 = 503.9888 → 503.99
      taxCents: 50399,
      totalCents: 365392,
      source: "bot",
      isTest: false,
      notes: "Incluye visita",
    });
    expect(quote.items).toEqual([
      expect.objectContaining({ serviceId: a.svc, quantity: 2, unitPriceCents: 150000, lineTotalCents: 300000 }),
      expect.objectContaining({ serviceId: a.svc2, quantity: 1.5, unitPriceCents: 9995, lineTotalCents: 14993 }),
    ]);

    const { d, s } = await db();
    const { eq } = await import("drizzle-orm");
    const row = (await d.select().from(s.quote).where(eq(s.quote.id, quote.id as string)))[0]!;
    expect(row.organizationId).toBe(a.org);
    expect(row.leadId).toBe(a.lead);
  });

  it("rechaza cualquier monto en el body (422) y no crea nada", async () => {
    const r = await routes();
    const before = await quoteCount(a.org);
    const attempts = [
      { conversationId: a.conv, items: [{ serviceId: a.svc, unitPriceCents: 1 }] },
      { conversationId: a.conv, items: [{ serviceId: a.svc }], totalCents: 1 },
      { conversationId: a.conv, items: [{ serviceId: a.svc }], organizationId: b.org },
      { conversationId: a.conv, items: [{ serviceId: a.svc, quantity: 1.0004 }] },
      { conversationId: a.conv, items: [] },
    ];
    for (const body of attempts) {
      const res = await r.create(a.key, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(await quoteCount(a.org)).toBe(before);
  });

  it("una conversación o un servicio de otro negocio es 404 y no consume folio", async () => {
    const r = await routes();
    const beforeA = await quoteCount(a.org);
    const beforeB = await quoteCount(b.org);

    const foreignConv = await r.create(a.key, { conversationId: b.conv, items: [{ serviceId: a.svc }] });
    expect(foreignConv.status).toBe(404);
    const foreignSvc = await r.create(a.key, { conversationId: a.conv, items: [{ serviceId: b.svc }] });
    expect(foreignSvc.status).toBe(404);
    const mixed = await r.create(a.key, {
      conversationId: a.conv,
      items: [{ serviceId: a.svc }, { serviceId: b.svc2 }],
    });
    expect(mixed.status).toBe(404);

    expect(await quoteCount(a.org)).toBe(beforeA);
    expect(await quoteCount(b.org)).toBe(beforeB);

    // El folio de B arranca en 1 aunque A ya tenga cotizaciones.
    const firstB = await r.create(b.key, { conversationId: b.conv, items: [{ serviceId: b.svc }] });
    expect(firstB.status).toBe(201);
    expect(((await firstB.json()) as { quote: { folio: string } }).quote.folio).toBe("COT-0001");
  });

  it("servicio inactivo o monedas mezcladas es 422", async () => {
    const r = await routes();
    expect((await r.create(a.key, { conversationId: a.conv, items: [{ serviceId: a.inactive }] })).status).toBe(422);
    const mixed = await r.create(a.key, {
      conversationId: a.conv,
      items: [{ serviceId: a.svc }, { serviceId: a.usd }],
    });
    expect(mixed.status).toBe(422);
    expect(((await mixed.json()) as { error: { code: string } }).error.code).toBe("currency_mismatch");
  });

  it("leer una cotización de otro negocio es 404; la propia es 200", async () => {
    const r = await routes();
    const own = await r.create(b.key, { conversationId: b.conv, items: [{ serviceId: b.svc2 }] });
    const quoteB = ((await own.json()) as { quote: { id: string } }).quote.id;

    expect((await r.get(a.key, quoteB)).status).toBe(404);
    const res = await r.get(b.key, quoteB);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { quote: { id: string } }).quote.id).toBe(quoteB);
  });

  it("la lista solo trae cotizaciones del negocio; filtrar por conversación ajena es 404", async () => {
    const r = await routes();
    const listA = (await (await r.list(a.key, "?limit=100")).json()) as { quotes: { id: string; contactId: string }[] };
    expect(listA.quotes.length).toBeGreaterThan(0);
    for (const q of listA.quotes) expect([a.contact]).toContain(q.contactId);

    expect((await r.list(a.key, `?conversationId=${b.conv}`)).status).toBe(404);
    const byConv = await r.list(a.key, `?conversationId=${a.conv}`);
    expect(byConv.status).toBe(200);
  });

  it("con precios que ya incluyen IVA, el total es el subtotal y el IVA se desglosa", async () => {
    const c = await seedTenant();
    const { d, s } = await db();
    await d.insert(s.quoteSettings).values({ organizationId: c.org, pricesIncludeTax: true, taxRateBps: 1600 });
    const r = await routes();
    const res = await r.create(c.key, { conversationId: c.conv, items: [{ serviceId: c.svc }] });
    const { quote } = (await res.json()) as { quote: Record<string, number | boolean> };
    // 1500.00 con IVA: base 1293.10, IVA 206.90.
    expect(quote).toMatchObject({ pricesIncludeTax: true, subtotalCents: 150000, taxCents: 20690, totalCents: 150000 });
  });

  it("cambiar el precio del catálogo o la configuración de IVA no altera una cotización ya creada", async () => {
    const c = await seedTenant();
    const r = await routes();
    const res = await r.create(c.key, { conversationId: c.conv, items: [{ serviceId: c.svc }] });
    const id = ((await res.json()) as { quote: { id: string } }).quote.id;

    const { d, s } = await db();
    const { eq } = await import("drizzle-orm");
    await d.update(s.service).set({ priceCents: 1 }).where(eq(s.service.id, c.svc));
    await d.insert(s.quoteSettings).values({ organizationId: c.org, pricesIncludeTax: true, taxRateBps: 800 });

    const after = (await (await r.get(c.key, id)).json()) as { quote: Record<string, unknown> & { items: { unitPriceCents: number }[] } };
    expect(after.quote).toMatchObject({ subtotalCents: 150000, taxCents: 24000, totalCents: 174000, taxRateBps: 1600 });
    expect(after.quote.items[0]!.unitPriceCents).toBe(150000);
  });

  it("altas simultáneas del mismo negocio reciben folios consecutivos sin repetir", async () => {
    const c = await seedTenant();
    const r = await routes();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => r.create(c.key, { conversationId: c.conv, items: [{ serviceId: c.svc2 }] }))
    );
    const folios = await Promise.all(
      responses.map(async (res) => {
        expect(res.status).toBe(201);
        return ((await res.json()) as { quote: { folio: string } }).quote.folio;
      })
    );
    expect(folios.sort()).toEqual(Array.from({ length: 8 }, (_, i) => `COT-000${i + 1}`));
  });

  it("una cotización de una conversación del Laboratorio queda marcada como prueba", async () => {
    const r = await routes();
    const res = await r.create(a.key, { conversationId: a.labConv, items: [{ serviceId: a.svc }] });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { quote: { isTest: boolean } }).quote.isTest).toBe(true);
  });
});
