import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Ajustes de cotizaciones contra un Postgres REAL: solo owner y admin editan,
 * la plantilla debe ser del negocio, aprobada y con 3 variables, el IVA va de
 * 0 a 100 % con 2 decimales, cada negocio tiene su propia fila y con la
 * bandera apagada todo es 404 sin escribir.
 *
 * Opcional: corre solo con `VOCERO_TEST_PG_URL` (base DESCARTABLE). El release
 * gate la exige.
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

const h = vi.hoisted(() => ({
  session: null as null | { userId: string; organizationId: string; role: "owner" | "admin" | "agent" },
}));

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    ...original,
    requireSession: async () => {
      if (!h.session) throw new original.UnauthorizedError();
      return { sessionId: "s1", isSuperadmin: false, ...h.session };
    },
  };
});
vi.mock("@/server/commercial/entitlement", () => ({ getCommercialAccess: async () => ({ allowed: true }) }));

type Tenant = { org: string; good: string; pending: string; twoVars: string };
const orgs: string[] = [];
let seq = 0;
let a: Tenant;
let b: Tenant;

async function mods() {
  const { getDb, schema } = await import("@/lib/db");
  return { d: getDb(), s: schema, orm: await import("drizzle-orm") };
}

async function seed(label: string): Promise<Tenant> {
  const { d, s } = await mods();
  seq += 1;
  const tag = `${Date.now().toString(36)}${seq}`;
  const t: Tenant = { org: `org_qs${tag}`, good: `tpl_qsg${tag}`, pending: `tpl_qsp${tag}`, twoVars: `tpl_qsv${tag}` };
  orgs.push(t.org);
  await d.insert(s.organization).values({ id: t.org, name: `Org ${label}` });
  await d.insert(s.template).values([
    { id: t.good, organizationId: t.org, name: `buena_${tag}`, language: "es_MX", category: "UTILITY", body: "Hola {{1}}, {{2}}: {{3}}", status: "approved" },
    { id: t.pending, organizationId: t.org, name: `pendiente_${tag}`, language: "es_MX", category: "UTILITY", body: "{{1}} {{2}} {{3}}", status: "pending" },
    { id: t.twoVars, organizationId: t.org, name: `dos_${tag}`, language: "es_MX", category: "UTILITY", body: "Hola {{1}}: {{2}}", status: "approved" },
  ]);
  return t;
}

function as(t: Tenant, role: "owner" | "admin" | "agent") {
  h.session = { userId: `usr_${role}`, organizationId: t.org, role };
}

async function api() {
  const route = await import("@/app/api/quotes/settings/route");
  return {
    get: () => route.GET(),
    put: (body: unknown) =>
      route.PUT(new Request("http://localhost/api/quotes/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })),
  };
}

const valid = (t: Tenant) => ({ pricesIncludeTax: true, taxRatePercent: 8, defaultValidityDays: 30, whatsappTemplateId: t.good });

async function settingsRow(org: string) {
  const { d, s, orm } = await mods();
  return (await d.select().from(s.quoteSettings).where(orm.eq(s.quoteSettings.organizationId, org)))[0] ?? null;
}

describe.skipIf(!PG_URL)("cotizaciones: Ajustes (Postgres real)", () => {
  beforeAll(async () => {
    vi.stubEnv("COTIZACIONES", "on");
    a = await seed("A");
    b = await seed("B");
  });

  afterEach(() => {
    vi.stubEnv("COTIZACIONES", "on");
    h.session = null;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    const { d, s, orm } = await mods();
    if (orgs.length) await d.delete(s.organization).where(orm.inArray(s.organization.id, orgs));
  });

  it("owner y admin guardan; el agente no (403) pero sí puede leer", async () => {
    const r = await api();
    as(a, "owner");
    expect((await r.put(valid(a))).status).toBe(200);
    expect(await settingsRow(a.org)).toMatchObject({ pricesIncludeTax: true, taxRateBps: 800, defaultValidityDays: 30, whatsappTemplateId: a.good });

    as(a, "admin");
    expect((await r.put({ ...valid(a), taxRatePercent: 16 })).status).toBe(200);
    expect((await settingsRow(a.org))!.taxRateBps).toBe(1600);

    as(a, "agent");
    expect((await r.put({ ...valid(a), taxRatePercent: 0 })).status).toBe(403);
    expect((await settingsRow(a.org))!.taxRateBps).toBe(1600);
    const read = await r.get();
    expect(read.status).toBe(200);
    const body = (await read.json()) as { settings: { taxRatePercent: number }; templates: { id: string; eligible: boolean }[] };
    expect(body.settings.taxRatePercent).toBe(16);
    expect(body.templates.find((t) => t.id === a.good)!.eligible).toBe(true);
    expect(body.templates.find((t) => t.id === a.pending)!.eligible).toBe(false);
    expect(body.templates.find((t) => t.id === a.twoVars)!.eligible).toBe(false);
    expect(body.templates.map((t) => t.id)).not.toContain(b.good);
  });

  it("solo acepta una plantilla del negocio, aprobada y con exactamente 3 variables", async () => {
    const r = await api();
    as(a, "owner");
    for (const id of [b.good, a.pending, a.twoVars, "tpl_inexistente"]) {
      const res = await r.put({ ...valid(a), whatsappTemplateId: id });
      expect(res.status, id).toBe(422);
    }
    expect((await r.put({ ...valid(a), whatsappTemplateId: null })).status).toBe(200);
    expect((await settingsRow(a.org))!.whatsappTemplateId).toBeNull();
  });

  it("IVA de 0 a 100 % con hasta 2 decimales; vigencia de 1 a 365", async () => {
    const r = await api();
    as(a, "owner");
    for (const ok of [0, 100, 8.5, 16.25]) expect((await r.put({ ...valid(a), taxRatePercent: ok })).status, String(ok)).toBe(200);
    expect((await settingsRow(a.org))!.taxRateBps).toBe(1625);
    for (const bad of [-1, 100.01, 8.555]) expect((await r.put({ ...valid(a), taxRatePercent: bad })).status, String(bad)).toBe(422);
    for (const bad of [0, 366, 1.5]) expect((await r.put({ ...valid(a), defaultValidityDays: bad })).status, String(bad)).toBe(422);
  });

  it("cada negocio tiene su propia configuración", async () => {
    const r = await api();
    as(a, "owner");
    expect((await r.put({ ...valid(a), taxRatePercent: 4 })).status).toBe(200);
    expect(await settingsRow(b.org)).toBeNull();
    as(b, "owner");
    expect((await r.put({ ...valid(b), taxRatePercent: 10 })).status).toBe(200);
    expect((await settingsRow(a.org))!.taxRateBps).toBe(400);
    expect((await settingsRow(b.org))!.taxRateBps).toBe(1000);
  });

  it("cambiar el IVA no altera cotizaciones ya creadas", async () => {
    const { d, s } = await mods();
    const tag = `${Date.now().toString(36)}`;
    await d.insert(s.contact).values({ id: `ct_qs${tag}`, organizationId: a.org, waIdentity: `52144${tag}`, name: "C" });
    await d.insert(s.conversation).values({ id: `cv_qs${tag}`, organizationId: a.org, contactId: `ct_qs${tag}` });
    await d.insert(s.service).values({ id: `svc_qs${tag}`, organizationId: a.org, name: `S ${tag}`, durationMinutes: 30, priceCents: 10000 });
    const r = await api();
    as(a, "owner");
    await r.put({ ...valid(a), pricesIncludeTax: false, taxRatePercent: 16 });
    const { createDraftQuote, getQuote } = await import("@/server/quotes/service");
    const q = await createDraftQuote({ organizationId: a.org, conversationId: `cv_qs${tag}`, items: [{ serviceId: `svc_qs${tag}`, quantityMilli: 1000 }], source: "manual" });
    await r.put({ ...valid(a), pricesIncludeTax: true, taxRatePercent: 0 });
    expect(await getQuote(a.org, q.id)).toMatchObject({ taxRateBps: 1600, pricesIncludeTax: false, totalCents: 11600 });
  });

  it("bandera apagada: 404 y nada se escribe; la pantalla no existe", async () => {
    const r = await api();
    as(a, "owner");
    const before = JSON.stringify(await settingsRow(a.org));
    vi.stubEnv("COTIZACIONES", "");
    expect((await r.get()).status).toBe(404);
    expect((await r.put({ ...valid(a), taxRatePercent: 50 })).status).toBe(404);
    expect(JSON.stringify(await settingsRow(a.org))).toBe(before);
    const page = await import("@/app/(app)/settings/quotes/page");
    let digest: string | undefined;
    try {
      await page.default();
    } catch (err) {
      digest = (err as { digest?: string }).digest;
    }
    expect(digest).toContain("404");
  });
});
