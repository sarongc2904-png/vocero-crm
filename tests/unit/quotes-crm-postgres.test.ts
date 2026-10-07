import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Pantallas y API del CRM de cotizaciones contra un Postgres REAL, con la
 * sesión simulada (rol y organización a elección de cada prueba).
 *
 * Fija:
 *  - aislamiento: con la sesión de A, todo id de B es 404 y nada de B cambia;
 *    listas y opciones nunca traen datos de B;
 *  - permisos: agent lee y arma borradores, pero no publica (403); owner sí;
 *    sin sesión, 401;
 *  - bandera apagada: 404 en toda la API sin siquiera mirar la sesión,
 *    `notFound()` en las pantallas y cero escrituras;
 *  - el detalle nunca devuelve el token de un enlace.
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
  sessionCalls: 0,
}));

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    ...original,
    requireSession: async () => {
      h.sessionCalls += 1;
      if (!h.session) throw new original.UnauthorizedError();
      return { sessionId: "s1", isSuperadmin: false, ...h.session };
    },
  };
});
vi.mock("@/server/commercial/entitlement", () => ({
  getCommercialAccess: async () => ({ allowed: true }),
}));

type Tenant = { org: string; owner: string; agent: string; contact: string; conv: string; labConv: string; svc: string };
const created: { orgs: string[]; users: string[] } = { orgs: [], users: [] };
let seq = 0;
let a: Tenant;
let b: Tenant;

async function mods() {
  const { getDb, schema } = await import("@/lib/db");
  return { d: getDb(), s: schema, orm: await import("drizzle-orm") };
}

async function seedTenant(label: string): Promise<Tenant> {
  const { d, s } = await mods();
  seq += 1;
  const tag = `${Date.now().toString(36)}${seq}`;
  const t: Tenant = {
    org: `org_qc${tag}`,
    owner: `usr_qco${tag}`,
    agent: `usr_qca${tag}`,
    contact: `ct_qc${tag}`,
    conv: `cv_qc${tag}`,
    labConv: `cv_qcl${tag}`,
    svc: `svc_qc${tag}`,
  };
  created.orgs.push(t.org);
  created.users.push(t.owner, t.agent);
  await d.insert(s.organization).values({ id: t.org, name: `${label} ${tag}` });
  await d.insert(s.user).values([
    { id: t.owner, name: `Dueña ${label}`, email: `${t.owner}@example.test` },
    { id: t.agent, name: `Agente ${label}`, email: `${t.agent}@example.test` },
  ]);
  await d.insert(s.member).values([
    { id: `mem_o${tag}`, organizationId: t.org, userId: t.owner, role: "owner" },
    { id: `mem_a${tag}`, organizationId: t.org, userId: t.agent, role: "agent" },
  ]);
  await d.insert(s.contact).values([
    { id: t.contact, organizationId: t.org, waIdentity: `52199${tag}`, name: `Cliente ${label}` },
    { id: `${t.contact}l`, organizationId: t.org, waIdentity: `52198${tag}`, name: `Lab ${label}` },
  ]);
  await d.insert(s.conversation).values([
    { id: t.conv, organizationId: t.org, contactId: t.contact },
    { id: t.labConv, organizationId: t.org, contactId: `${t.contact}l`, isTest: true },
  ]);
  await d.insert(s.service).values({ id: t.svc, organizationId: t.org, name: `Servicio ${label} ${tag}`, durationMinutes: 60, priceCents: 120000 });
  return t;
}

function as(t: Tenant, role: "owner" | "agent") {
  h.session = { userId: role === "owner" ? t.owner : t.agent, organizationId: t.org, role };
}

function req(path: string, init: { method?: string; body?: unknown } = {}) {
  return new Request(`http://localhost:3000${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function api() {
  const list = await import("@/app/api/quotes/route");
  const one = await import("@/app/api/quotes/[id]/route");
  const link = await import("@/app/api/quotes/[id]/link/route");
  const markSent = await import("@/app/api/quotes/[id]/mark-sent/route");
  const cancel = await import("@/app/api/quotes/[id]/cancel/route");
  const dup = await import("@/app/api/quotes/[id]/duplicate/route");
  const options = await import("@/app/api/quotes/options/route");
  const p = (id: string) => ({ params: Promise.resolve({ id }) });
  return {
    list: (qs = "") => list.GET(req(`/api/quotes${qs}`)),
    create: (body: unknown) => list.POST(req("/api/quotes", { method: "POST", body })),
    get: (id: string) => one.GET(req(`/api/quotes/${id}`), p(id)),
    edit: (id: string, body: unknown) => one.PATCH(req(`/api/quotes/${id}`, { method: "PATCH", body }), p(id)),
    issue: (id: string) => link.POST(req(`/api/quotes/${id}/link`, { method: "POST" }), p(id)),
    revoke: (id: string) => link.DELETE(req(`/api/quotes/${id}/link`, { method: "DELETE" }), p(id)),
    markSent: (id: string) => markSent.POST(req(`/api/quotes/${id}/mark-sent`, { method: "POST" }), p(id)),
    cancel: (id: string) => cancel.POST(req(`/api/quotes/${id}/cancel`, { method: "POST" }), p(id)),
    duplicate: (id: string) => dup.POST(req(`/api/quotes/${id}/duplicate`, { method: "POST" }), p(id)),
    options: () => options.GET(),
  };
}

async function draftFor(t: Tenant): Promise<string> {
  as(t, "owner");
  const r = await api();
  const res = await r.create({ conversationId: t.conv, items: [{ serviceId: t.svc, quantity: 1 }] });
  expect(res.status).toBe(201);
  return ((await res.json()) as { quote: { id: string } }).quote.id;
}

async function snapshotOrg(org: string): Promise<string> {
  const { d, s, orm } = await mods();
  return JSON.stringify({
    quotes: await d.select().from(s.quote).where(orm.eq(s.quote.organizationId, org)).orderBy(s.quote.id),
    items: await d.select().from(s.quoteItem).where(orm.eq(s.quoteItem.organizationId, org)).orderBy(s.quoteItem.id),
    links: await d.select().from(s.quoteLink).where(orm.eq(s.quoteLink.organizationId, org)).orderBy(s.quoteLink.id),
    counter: await d.select().from(s.quoteCounter).where(orm.eq(s.quoteCounter.organizationId, org)),
  });
}

async function expectNotFoundPage(run: () => Promise<unknown>) {
  let digest: string | undefined;
  try {
    await run();
  } catch (err) {
    digest = (err as { digest?: string }).digest;
  }
  expect(digest).toContain("404");
}

describe.skipIf(!PG_URL)("cotizaciones: CRM (API + pantallas) en Postgres real", () => {
  beforeAll(async () => {
    vi.stubEnv("COTIZACIONES", "on");
    a = await seedTenant("A");
    b = await seedTenant("B");
  });

  afterEach(() => {
    vi.stubEnv("COTIZACIONES", "on");
    h.session = null;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    const { d, s, orm } = await mods();
    if (created.orgs.length) await d.delete(s.organization).where(orm.inArray(s.organization.id, created.orgs));
    if (created.users.length) await d.delete(s.user).where(orm.inArray(s.user.id, created.users));
  });

  describe("aislamiento por organization_id", () => {
    it("con la sesión de A, toda operación sobre una cotización de B es 404 y B no cambia", async () => {
      const quoteB = await draftFor(b);
      const r = await api();
      const before = await snapshotOrg(b.org);
      as(a, "owner");
      const responses = [
        await r.get(quoteB),
        await r.edit(quoteB, { items: [{ serviceId: a.svc, quantity: 9 }] }),
        await r.issue(quoteB),
        await r.revoke(quoteB),
        await r.markSent(quoteB),
        await r.cancel(quoteB),
        await r.duplicate(quoteB),
      ];
      expect(responses.map((res) => res.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
      expect(await snapshotOrg(b.org)).toBe(before);
    });

    it("A no puede crear una cotización con la conversación o el servicio de B", async () => {
      const r = await api();
      const before = await snapshotOrg(b.org);
      as(a, "owner");
      expect((await r.create({ conversationId: b.conv, items: [{ serviceId: a.svc }] })).status).toBe(404);
      expect((await r.create({ conversationId: a.conv, items: [{ serviceId: b.svc }] })).status).toBe(404);
      expect(await snapshotOrg(b.org)).toBe(before);
    });

    it("la lista y las opciones del formulario solo traen datos de A (sin el Laboratorio)", async () => {
      await draftFor(a);
      await draftFor(b);
      const r = await api();
      as(a, "owner");
      const list = (await (await r.list()).json()) as { quotes: { contactName: string }[] };
      expect(list.quotes.length).toBeGreaterThan(0);
      for (const q of list.quotes) expect(q.contactName).toBe("Cliente A");

      const opts = (await (await r.options()).json()) as { conversations: { id: string }[]; services: { id: string }[] };
      expect(opts.conversations.map((c) => c.id)).toEqual([a.conv]);
      expect(opts.services.map((s) => s.id)).toEqual([a.svc]);
    });

    it("las pantallas de detalle no muestran cotizaciones de otro negocio", async () => {
      const quoteB = await draftFor(b);
      as(a, "owner");
      const page = await import("@/app/(app)/quotes/[id]/page");
      await expectNotFoundPage(() => page.default({ params: Promise.resolve({ id: quoteB }) }));
    });

    it("los nombres de operadores solo se resuelven entre miembros del mismo negocio", async () => {
      const { getQuoteDetailForCrm } = await import("@/server/quotes/crm");
      const quoteA = await draftFor(a);
      const { d, s, orm } = await mods();
      // Aunque alguien forzara un usuario de B como creador, A no ve su nombre.
      await d.update(s.quote).set({ createdBy: b.owner }).where(orm.eq(s.quote.id, quoteA));
      const detail = await getQuoteDetailForCrm(a.org, quoteA);
      expect(detail!.createdByName).toBeNull();
    });
  });

  describe("permisos", () => {
    it("agent lee, crea y edita borradores, pero no publica, cancela ni duplica (403)", async () => {
      const quote = await draftFor(a);
      const r = await api();
      as(a, "agent");
      expect((await r.list()).status).toBe(200);
      expect((await r.get(quote)).status).toBe(200);
      expect((await r.options()).status).toBe(200);
      expect((await r.create({ conversationId: a.conv, items: [{ serviceId: a.svc }] })).status).toBe(201);
      expect((await r.edit(quote, { items: [{ serviceId: a.svc, quantity: 2 }] })).status).toBe(200);
      const before = await snapshotOrg(a.org);
      for (const res of [await r.issue(quote), await r.revoke(quote), await r.markSent(quote), await r.cancel(quote), await r.duplicate(quote)]) {
        expect(res.status).toBe(403);
      }
      expect(await snapshotOrg(a.org)).toBe(before);
    });

    it("owner completa el ciclo: emitir, marcar enviada, duplicar", async () => {
      const quote = await draftFor(a);
      const r = await api();
      as(a, "owner");
      const issued = await r.issue(quote);
      expect(issued.status).toBe(201);
      expect(issued.headers.get("cache-control")).toContain("no-store");
      const { url, token } = (await issued.json()) as { url: string; token: string };
      expect(url).toBe(`http://localhost:3000/p/${token}`);
      expect((await r.markSent(quote)).status).toBe(200);
      const dup = await r.duplicate(quote);
      expect(dup.status).toBe(201);
      const { original, copy } = (await dup.json()) as { original: { status: string }; copy: { status: string } };
      expect(original.status).toBe("cancelada");
      expect(copy.status).toBe("borrador");
    });

    it("sin sesión responde 401", async () => {
      h.session = null;
      const r = await api();
      expect((await r.list()).status).toBe(401);
      expect((await r.create({ conversationId: a.conv, items: [{ serviceId: a.svc }] })).status).toBe(401);
    });

    it("la pantalla Nueva no existe para quien no tiene quotes.manage", async () => {
      const { requireQuotesPage } = await import("@/server/quotes/page-access");
      as(a, "agent");
      await expect(requireQuotesPage("quotes.manage")).resolves.toMatchObject({ can: { manage: true, publish: false } });
      await expectNotFoundPage(() => requireQuotesPage("quotes.publish"));
    });
  });

  it("el detalle nunca devuelve el token del enlace, solo si hay uno vigente", async () => {
    const quote = await draftFor(a);
    const r = await api();
    as(a, "owner");
    const { token } = (await (await r.issue(quote)).json()) as { token: string };
    const body = await (await r.get(quote)).text();
    expect(body).not.toContain(token);
    expect(JSON.parse(body).link.active).toBe(true);
  });

  it("el filtro 'del bot' lista los borradores creados por el bot", async () => {
    const { createDraftQuote } = await import("@/server/quotes/service");
    const botQuote = await createDraftQuote({ organizationId: a.org, conversationId: a.conv, items: [{ serviceId: a.svc, quantityMilli: 1000 }], source: "bot" });
    const r = await api();
    as(a, "agent");
    const res = (await (await r.list("?filter=bot")).json()) as { quotes: { id: string; source: string; status: string }[] };
    expect(res.quotes.map((q) => q.id)).toContain(botQuote.id);
    for (const q of res.quotes) expect(q).toMatchObject({ source: "bot", status: "borrador" });
  });

  describe("bandera apagada", () => {
    it("toda la API responde 404 sin consultar la sesión, y no escribe nada", async () => {
      const quote = await draftFor(a);
      const r = await api();
      as(a, "owner");
      const before = await snapshotOrg(a.org);
      vi.stubEnv("COTIZACIONES", "");
      h.sessionCalls = 0;
      const responses = [
        await r.list(),
        await r.create({ conversationId: a.conv, items: [{ serviceId: a.svc }] }),
        await r.get(quote),
        await r.edit(quote, { items: [{ serviceId: a.svc, quantity: 3 }] }),
        await r.issue(quote),
        await r.revoke(quote),
        await r.markSent(quote),
        await r.cancel(quote),
        await r.duplicate(quote),
        await r.options(),
      ];
      expect(responses.every((res) => res.status === 404)).toBe(true);
      expect(h.sessionCalls).toBe(0);
      expect(await snapshotOrg(a.org)).toBe(before);
    });

    it("las tres pantallas son notFound()", async () => {
      const quote = await draftFor(a);
      vi.stubEnv("COTIZACIONES", "");
      as(a, "owner");
      const list = await import("@/app/(app)/quotes/page");
      const create = await import("@/app/(app)/quotes/new/page");
      const detail = await import("@/app/(app)/quotes/[id]/page");
      await expectNotFoundPage(() => list.default({ searchParams: Promise.resolve({}) }));
      await expectNotFoundPage(() => create.default({ searchParams: Promise.resolve({}) }));
      await expectNotFoundPage(() => detail.default({ params: Promise.resolve({ id: quote }) }));
    });
  });
});
