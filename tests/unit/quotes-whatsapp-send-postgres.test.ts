import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Envío de cotizaciones por WhatsApp contra un Postgres REAL y la API de Meta
 * SIMULADA. `fetch` se reemplaza por un Graph falso en `graph.mock.test`; una
 * llamada a cualquier otro host (en especial graph.facebook.com) hace fallar
 * la prueba. CERO llamadas reales.
 *
 * Fija: ventana abierta (PDF), ventana cerrada con plantilla, sin plantilla
 * (bloqueo sin llamar a Meta), fallo de Meta (queda borrador, enlace
 * revocado), concurrencia (un solo envío), idempotencia, aislamiento A/B,
 * Laboratorio, bandera apagada, límite por negocio, intentos inciertos y que
 * el token NO aparezca en base, logs, errores ni SSE.
 *
 * Opcional: corre solo con `VOCERO_TEST_PG_URL` (base DESCARTABLE). El release
 * gate la exige.
 */

const PG_URL = process.env.VOCERO_TEST_PG_URL;
const GRAPH = "http://graph.mock.test";

vi.hoisted(() => {
  const url = process.env.VOCERO_TEST_PG_URL;
  if (!url) return;
  process.env.DATABASE_URL = url;
  process.env.APP_BASE_URL = "https://crm.ejemplo.test";
  process.env.BETTER_AUTH_SECRET ??= "pg-test-secret-0123456789";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.META_WEBHOOK_VERIFY_TOKEN ??= "pg-test-verify";
  process.env.META_GRAPH_BASE_URL = "http://graph.mock.test";
  process.env.MEDIA_DIR = "./.tmp-test-media-quotes";
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
vi.mock("@/server/commercial/entitlement", () => ({ getCommercialAccess: async () => ({ allowed: true }) }));

/* ---------------- Graph simulado ---------------- */

type GraphCall = { url: string; body: string };
const graph = {
  calls: [] as GraphCall[],
  real: [] as string[],
  delayMs: 0,
  /** null = éxito; si no, el error que responde /messages. */
  failWith: null as null | { status: number; code: number; message: string; echo?: boolean },
};
let waSeq = 0;

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith(GRAPH)) {
    graph.real.push(url);
    throw new Error(`Llamada de red NO simulada: ${url}`);
  }
  const body = typeof init?.body === "string" ? init.body : "";
  graph.calls.push({ url, body });
  if (graph.delayMs) await new Promise((r) => setTimeout(r, graph.delayMs));
  if (url.endsWith("/media")) return Response.json({ id: `media_${++waSeq}` });
  if (url.endsWith("/messages")) {
    if (graph.failWith) {
      const f = graph.failWith;
      return Response.json(
        { error: { code: f.code, message: f.echo ? `${f.message}: ${body}` : f.message, type: "OAuthException" } },
        { status: f.status }
      );
    }
    return Response.json({ messages: [{ id: `wamid.TEST${++waSeq}` }] });
  }
  return Response.json({ error: { message: "ruta simulada desconocida" } }, { status: 404 });
}

const messageCalls = () => graph.calls.filter((c) => c.url.endsWith("/messages"));
const sentUrl = (call: GraphCall): string => {
  const match = /https:\/\/crm\.ejemplo\.test\/p\/([A-Za-z0-9_-]{43})/.exec(call.body);
  if (!match) throw new Error("el mensaje enviado no lleva el enlace");
  return match[0];
};
const tokenOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);

/* ---------------- captura de logs y SSE ---------------- */

const logs: string[] = [];
const events: string[] = [];
let unsubscribers: (() => void)[] = [];

/* ---------------- datos ---------------- */

type Tenant = {
  org: string;
  owner: string;
  agent: string;
  contact: string;
  openConv: string;
  closedConv: string;
  labConv: string;
  svc: string;
  template: string;
};
const created = { orgs: [] as string[], users: [] as string[] };
let seq = 0;
let a: Tenant;
let b: Tenant;

async function mods() {
  const { getDb, schema } = await import("@/lib/db");
  return { d: getDb(), s: schema, orm: await import("drizzle-orm") };
}

async function seedTenant(label: string): Promise<Tenant> {
  const { d, s } = await mods();
  const { saveCredentials } = await import("@/server/whatsapp/credentials");
  seq += 1;
  const tag = `${Date.now().toString(36)}${seq}`;
  const t: Tenant = {
    org: `org_qw${tag}`,
    owner: `usr_qwo${tag}`,
    agent: `usr_qwa${tag}`,
    contact: `ct_qw${tag}`,
    openConv: `cv_qwo${tag}`,
    closedConv: `cv_qwc${tag}`,
    labConv: `cv_qwl${tag}`,
    svc: `svc_qw${tag}`,
    template: `tpl_qw${tag}`,
  };
  created.orgs.push(t.org);
  created.users.push(t.owner, t.agent);
  await d.insert(s.organization).values({ id: t.org, name: `Negocio ${label} ${tag}` });
  await d.insert(s.user).values([
    { id: t.owner, name: `Dueña ${label}`, email: `${t.owner}@example.test` },
    { id: t.agent, name: `Agente ${label}`, email: `${t.agent}@example.test` },
  ]);
  await d.insert(s.member).values([
    { id: `mem_qwo${tag}`, organizationId: t.org, userId: t.owner, role: "owner" },
    { id: `mem_qwa${tag}`, organizationId: t.org, userId: t.agent, role: "agent" },
  ]);
  await d.insert(s.contact).values([
    { id: t.contact, organizationId: t.org, waIdentity: `5215511${String(seq).padStart(6, "0")}`, phone: `5215511${String(seq).padStart(6, "0")}`, name: `Ana ${label}` },
    { id: `${t.contact}x`, organizationId: t.org, waIdentity: `5215522${String(seq).padStart(6, "0")}`, phone: `5215522${String(seq).padStart(6, "0")}`, name: `Beto ${label}` },
    { id: `${t.contact}l`, organizationId: t.org, waIdentity: `5215533${String(seq).padStart(6, "0")}`, name: `Lab ${label}` },
  ]);
  await d.insert(s.conversation).values([
    { id: t.openConv, organizationId: t.org, contactId: t.contact, lastInboundAt: new Date() },
    { id: t.closedConv, organizationId: t.org, contactId: `${t.contact}x`, lastInboundAt: new Date(Date.now() - 30 * 3600_000) },
    { id: t.labConv, organizationId: t.org, contactId: `${t.contact}l`, isTest: true, lastInboundAt: new Date() },
  ]);
  await d.insert(s.service).values({ id: t.svc, organizationId: t.org, name: `Servicio ${label}`, durationMinutes: 60, priceCents: 150000 });
  await d.insert(s.template).values({
    id: t.template,
    organizationId: t.org,
    name: `cotizacion_${tag}`,
    language: "es_MX",
    category: "UTILITY",
    body: "Hola {{1}}, tu cotización {{2}} está lista: {{3}}",
    status: "approved",
  });
  await saveCredentials({ organizationId: t.org, wabaId: `WABA${tag}`, phoneNumberId: `PN${tag}`, token: `token-de-prueba-${tag}` });
  const { subscribe } = await import("@/server/events/bus");
  unsubscribers.push(subscribe(t.org, (e) => events.push(JSON.stringify(e))));
  return t;
}

async function draft(t: Tenant, conv: string): Promise<string> {
  const { createDraftQuote } = await import("@/server/quotes/service");
  const q = await createDraftQuote({ organizationId: t.org, conversationId: conv, items: [{ serviceId: t.svc, quantityMilli: 1000 }], source: "manual" });
  return q.id;
}

async function setTemplate(t: Tenant, templateId: string | null) {
  const { d, s } = await mods();
  await d
    .insert(s.quoteSettings)
    .values({ organizationId: t.org, whatsappTemplateId: templateId })
    .onConflictDoUpdate({ target: s.quoteSettings.organizationId, set: { whatsappTemplateId: templateId } });
}

function as(t: Tenant, role: "owner" | "agent" = "owner") {
  h.session = { userId: role === "owner" ? t.owner : t.agent, organizationId: t.org, role };
}

let keySeq = 0;
const newKey = () => `clave-prueba-${Date.now().toString(36)}-${++keySeq}`;

async function routes() {
  const send = await import("@/app/api/quotes/[id]/send/route");
  const resolve = await import("@/app/api/quotes/[id]/send/[sendId]/resolve/route");
  return {
    send: (quoteId: string, key: string | null = newKey()) =>
      send.POST(
        new Request(`https://crm.ejemplo.test/api/quotes/${quoteId}/send`, {
          method: "POST",
          headers: key ? { "idempotency-key": key, host: "atacante.example" } : { host: "atacante.example" },
        }),
        { params: Promise.resolve({ id: quoteId }) }
      ),
    resolve: (quoteId: string, sendId: string, outcome: string) =>
      resolve.POST(
        new Request(`https://crm.ejemplo.test/api/quotes/${quoteId}/send/${sendId}/resolve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ outcome }),
        }),
        { params: Promise.resolve({ id: quoteId, sendId }) }
      ),
  };
}

async function quoteRow(id: string) {
  const { d, s, orm } = await mods();
  return (await d.select().from(s.quote).where(orm.eq(s.quote.id, id)))[0]!;
}

/** Todo lo que el token NO debe tocar: base, logs y eventos SSE. */
async function expectTokenNowhere(token: string, extra: string[] = []) {
  const { d, s, orm } = await mods();
  const dump = JSON.stringify({
    messages: await d.select().from(s.message).where(orm.inArray(s.message.organizationId, created.orgs)),
    assets: await d.select().from(s.mediaAsset).where(orm.inArray(s.mediaAsset.organizationId, created.orgs)),
    sends: await d.select().from(s.quoteSend).where(orm.inArray(s.quoteSend.organizationId, created.orgs)),
    links: await d.select().from(s.quoteLink).where(orm.inArray(s.quoteLink.organizationId, created.orgs)),
    quotes: await d.select().from(s.quote).where(orm.inArray(s.quote.organizationId, created.orgs)),
    contacts: await d.select().from(s.contact).where(orm.inArray(s.contact.organizationId, created.orgs)),
  });
  expect(dump.includes(token), "token en la base").toBe(false);
  expect(logs.join("\n").includes(token), "token en logs").toBe(false);
  expect(events.join("\n").includes(token), "token en SSE").toBe(false);
  for (const text of extra) expect(text.includes(token), "token en una respuesta").toBe(false);
}

async function snapshotOrg(org: string) {
  const { d, s, orm } = await mods();
  return JSON.stringify({
    quotes: await d.select().from(s.quote).where(orm.eq(s.quote.organizationId, org)).orderBy(s.quote.id),
    links: await d.select().from(s.quoteLink).where(orm.eq(s.quoteLink.organizationId, org)).orderBy(s.quoteLink.id),
    sends: await d.select().from(s.quoteSend).where(orm.eq(s.quoteSend.organizationId, org)).orderBy(s.quoteSend.id),
    messages: await d.select().from(s.message).where(orm.eq(s.message.organizationId, org)).orderBy(s.message.id),
  });
}

// Generar el PDF y cargar los módulos la primera vez tarda más que el default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

describe.skipIf(!PG_URL)("cotizaciones: envío por WhatsApp (Postgres real + Meta simulado)", () => {
  beforeAll(async () => {
    vi.stubEnv("COTIZACIONES", "on");
    vi.stubGlobal("fetch", fakeFetch);
    for (const level of ["log", "info", "warn", "error"] as const) {
      const original = console[level].bind(console);
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : String(x))).join(" "));
        void original;
      });
    }
    a = await seedTenant("A");
    b = await seedTenant("B");
  });

  beforeEach(async () => {
    graph.calls = [];
    graph.failWith = null;
    graph.delayMs = 0;
    const { resetRateLimit } = await import("@/lib/rate-limit");
    resetRateLimit();
  });

  afterEach(() => {
    vi.stubEnv("COTIZACIONES", "on");
    h.session = null;
    expect(graph.real, "hubo llamadas de red reales").toEqual([]);
  });

  afterAll(async () => {
    for (const off of unsubscribers) off();
    unsubscribers = [];
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    const { d, s, orm } = await mods();
    if (created.orgs.length) await d.delete(s.organization).where(orm.inArray(s.organization.id, created.orgs));
    if (created.users.length) await d.delete(s.user).where(orm.inArray(s.user.id, created.users));
  });

  it("ventana abierta: manda el PDF con el enlace del dominio del CRM y la marca enviada", async () => {
    const quoteId = await draft(a, a.openConv);
    as(a);
    const r = await routes();
    const res = await r.send(quoteId);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(body).send.status).toBe("enviado");

    expect(graph.calls.filter((c) => c.url.endsWith("/media"))).toHaveLength(1);
    const msgs = messageCalls();
    expect(msgs).toHaveLength(1);
    const payload = JSON.parse(msgs[0]!.body) as { type: string; document: { caption: string; filename: string } };
    expect(payload.type).toBe("document");
    expect(payload.document.filename).toMatch(/^Cotizacion-COT-\d{4}\.pdf$/);
    const url = sentUrl(msgs[0]!);
    expect(url.startsWith("https://crm.ejemplo.test/p/")).toBe(true); // nunca el Host del request

    const q = await quoteRow(quoteId);
    expect(q).toMatchObject({ status: "enviada", sentVia: "whatsapp", sentBy: a.owner });

    const { getPublicQuote } = await import("@/server/quotes/public");
    expect(await getPublicQuote(tokenOf(url))).not.toBeNull();

    const { d, s, orm } = await mods();
    const [asset] = await d.select().from(s.mediaAsset).where(orm.eq(s.mediaAsset.organizationId, a.org)).orderBy(orm.desc(s.mediaAsset.createdAt)).limit(1);
    expect(asset!.caption).toContain("/p/••••••");
    await expectTokenNowhere(tokenOf(url), [body]);
  });

  it("ventana cerrada con plantilla aprobada: manda la plantilla con nombre, folio y enlace", async () => {
    await setTemplate(a, a.template);
    const quoteId = await draft(a, a.closedConv);
    as(a);
    const r = await routes();
    const res = await r.send(quoteId);
    expect(res.status).toBe(200);
    const msgs = messageCalls();
    expect(msgs).toHaveLength(1);
    const payload = JSON.parse(msgs[0]!.body) as {
      type: string;
      template: { components: { parameters: { text: string }[] }[] };
    };
    expect(payload.type).toBe("template");
    const params = payload.template.components[0]!.parameters.map((p) => p.text);
    expect(params[0]).toBe("Beto A");
    expect(params[1]).toMatch(/^COT-\d{4}$/);
    expect(params[2]).toMatch(/^https:\/\/crm\.ejemplo\.test\/p\/[A-Za-z0-9_-]{43}$/);
    expect((await quoteRow(quoteId)).status).toBe("enviada");

    const { d, s, orm } = await mods();
    const [stored] = await d.select().from(s.message).where(orm.and(orm.eq(s.message.organizationId, a.org), orm.eq(s.message.type, "template"))).orderBy(orm.desc(s.message.createdAt)).limit(1);
    expect(stored!.text).toContain("/p/••••••");
    await expectTokenNowhere(tokenOf(params[2]!));
    await setTemplate(a, null);
  });

  it("ventana cerrada sin plantilla (o no aprobada, o con otras variables): bloquea con mensaje claro y 0 llamadas", async () => {
    const r = await routes();
    as(a);
    const { d, s } = await mods();
    const unapproved = `${a.template}u`;
    const twoVars = `${a.template}v`;
    await d.insert(s.template).values([
      { id: unapproved, organizationId: a.org, name: `${unapproved}n`, language: "es_MX", category: "UTILITY", body: "{{1}} {{2}} {{3}}", status: "pending" },
      { id: twoVars, organizationId: a.org, name: `${twoVars}n`, language: "es_MX", category: "UTILITY", body: "Hola {{1}}: {{2}}", status: "approved" },
    ]);
    for (const templateId of [null, unapproved, twoVars, b.template]) {
      if (templateId === b.template) {
        // La FK compuesta impide siquiera guardar la plantilla de OTRO negocio.
        await expect(setTemplate(a, b.template)).rejects.toBeTruthy();
        continue;
      }
      await setTemplate(a, templateId);
      const quoteId = await draft(a, a.closedConv);
      const before = await snapshotOrg(a.org);
      const res = await r.send(quoteId);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("no_template");
      expect(body.error.message).toContain("Ajustes de cotizaciones");
      expect(messageCalls()).toHaveLength(0);
      expect((await quoteRow(quoteId)).status).toBe("borrador");
      expect(await snapshotOrg(a.org)).toBe(before);
    }
    await setTemplate(a, null);
  });

  for (const failure of [
    { status: 400, code: 131026, expect: "no puede recibir mensajes" },
    { status: 400, code: 131047, expect: "24 h" },
    { status: 429, code: 130429, expect: "límite" },
    { status: 400, code: 999999, expect: "código 999999" },
    { status: 500, code: 1, expect: "no está disponible" },
  ]) {
    it(`fallo de Meta (${failure.code}): queda borrador, enlace revocado, mensaje traducido sin texto crudo`, async () => {
      graph.failWith = { status: failure.status, code: failure.code, message: "TEXTO-CRUDO-DE-META", echo: true };
      const quoteId = await draft(a, a.openConv);
      as(a);
      const r = await routes();
      const res = await r.send(quoteId);
      const body = await res.text();
      expect(res.status).toBe(502);
      const send = JSON.parse(body).send as { status: string; errorMessage: string };
      expect(send.status).toBe("fallido");
      expect(send.errorMessage).toContain(failure.expect);
      expect(send.errorMessage).not.toContain("TEXTO-CRUDO-DE-META");

      expect((await quoteRow(quoteId)).status).toBe("borrador");
      const url = sentUrl(messageCalls()[0]!);
      const { getPublicQuote } = await import("@/server/quotes/public");
      expect(await getPublicQuote(tokenOf(url))).toBeNull(); // enlace del intento revocado
      // Meta "repitió" lo enviado en su error: el token tampoco quedó en ningún lado.
      await expectTokenNowhere(tokenOf(url), [body]);
    });
  }

  it("concurrencia: 5 clics con la MISMA clave mandan un solo mensaje y un solo enlace", async () => {
    graph.delayMs = 150;
    const quoteId = await draft(a, a.openConv);
    as(a);
    const r = await routes();
    const key = newKey();
    const responses = await Promise.all(Array.from({ length: 5 }, () => r.send(quoteId, key)));
    const bodies = await Promise.all(responses.map(async (res) => (await res.json()) as { send: { id: string } }));
    expect(new Set(bodies.map((x) => x.send.id)).size).toBe(1);
    expect(messageCalls()).toHaveLength(1);
    const { d, s, orm } = await mods();
    const live = await d.select().from(s.quoteLink).where(orm.and(orm.eq(s.quoteLink.quoteId, quoteId), orm.isNull(s.quoteLink.revokedAt)));
    expect(live).toHaveLength(1);
    // Reintentar DESPUÉS con la misma clave tampoco reenvía.
    expect((await r.send(quoteId, key)).status).toBe(200);
    expect(messageCalls()).toHaveLength(1);
  });

  it("concurrencia: 5 clics con claves DISTINTAS mandan un solo mensaje; los demás 409", async () => {
    graph.delayMs = 150;
    const quoteId = await draft(a, a.openConv);
    as(a);
    const r = await routes();
    const responses = await Promise.all(Array.from({ length: 5 }, () => r.send(quoteId)));
    const statuses = responses.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409]);
    expect(messageCalls()).toHaveLength(1);
  });

  it("aislamiento: el operador de A no puede enviar ni resolver envíos de B (404, 0 llamadas, B intacto)", async () => {
    const quoteB = await draft(b, b.openConv);
    as(b);
    const r = await routes();
    expect((await r.send(quoteB)).status).toBe(200);
    graph.calls = [];
    const { getLatestQuoteSend } = await import("@/server/quotes/whatsapp-send");
    const sendB = (await getLatestQuoteSend(b.org, quoteB))!;
    const otherDraftB = await draft(b, b.openConv);
    const before = await snapshotOrg(b.org);

    as(a);
    expect((await r.send(otherDraftB)).status).toBe(404);
    expect((await r.resolve(quoteB, sendB.id, "llego")).status).toBe(404);
    expect((await r.resolve(otherDraftB, sendB.id, "no_llego")).status).toBe(404);
    expect(messageCalls()).toHaveLength(0);
    expect(await snapshotOrg(b.org)).toBe(before);
  });

  it("Laboratorio: una cotización de una conversación de prueba nunca llama a Meta", async () => {
    const { createDraftQuote } = await import("@/server/quotes/service");
    const lab = await createDraftQuote({ organizationId: a.org, conversationId: a.labConv, items: [{ serviceId: a.svc, quantityMilli: 1000 }], source: "manual" });
    expect(lab.isTest).toBe(true);
    as(a);
    const r = await routes();
    const res = await r.send(lab.id);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("lab");
    expect(graph.calls).toHaveLength(0);
  });

  it("permisos: el agente no envía ni resuelve (403, 0 llamadas)", async () => {
    const quoteId = await draft(a, a.openConv);
    as(a, "agent");
    const r = await routes();
    expect((await r.send(quoteId)).status).toBe(403);
    expect((await r.resolve(quoteId, "qts_x", "llego")).status).toBe(403);
    expect(graph.calls).toHaveLength(0);
  });

  it("bandera apagada: 404 sin leer la sesión, 0 llamadas y 0 escrituras", async () => {
    const quoteId = await draft(a, a.openConv);
    as(a);
    const before = await snapshotOrg(a.org);
    vi.stubEnv("COTIZACIONES", "");
    h.sessionCalls = 0;
    const r = await routes();
    expect((await r.send(quoteId)).status).toBe(404);
    expect((await r.resolve(quoteId, "qts_x", "llego")).status).toBe(404);
    expect(h.sessionCalls).toBe(0);
    expect(graph.calls).toHaveLength(0);
    expect(await snapshotOrg(a.org)).toBe(before);
  });

  it("sin clave de idempotencia no se envía", async () => {
    const quoteId = await draft(a, a.openConv);
    as(a);
    const r = await routes();
    expect((await r.send(quoteId, null)).status).toBe(422);
    expect(graph.calls).toHaveLength(0);
  });

  it("límite por negocio: el envío 11 en un minuto es 429 y no llama a Meta; el otro negocio no se ve afectado", async () => {
    const { QUOTE_SEND_LIMITS } = await import("@/server/quotes/whatsapp-send");
    expect(QUOTE_SEND_LIMITS.perMinute.max).toBe(10);
    as(a);
    const r = await routes();
    for (let i = 0; i < QUOTE_SEND_LIMITS.perMinute.max; i += 1) {
      expect((await r.send(await draft(a, a.openConv))).status).toBe(200);
    }
    const callsBefore = messageCalls().length;
    const blocked = await r.send(await draft(a, a.openConv));
    expect(blocked.status).toBe(429);
    expect(messageCalls().length).toBe(callsBefore);
    as(b);
    expect((await r.send(await draft(b, b.openConv))).status).toBe(200);
  });

  it("límite por negocio: el intento 101 en una hora es 429", async () => {
    const { sendQuoteByWhatsApp, QUOTE_SEND_LIMITS, QuoteSendError } = await import("@/server/quotes/whatsapp-send");
    const start = Date.now();
    // Cada intento cuenta aunque falle la validación (aquí: cotización inexistente).
    for (let i = 0; i < QUOTE_SEND_LIMITS.perHour.max; i += 1) {
      const now = new Date(start + Math.floor(i / 10) * 61_000);
      await expect(
        sendQuoteByWhatsApp({ organizationId: a.org, quoteId: "qt_inexistente", userId: a.owner, idempotencyKey: newKey(), now })
      ).rejects.toMatchObject({ code: "not_found" });
    }
    const late = new Date(start + 11 * 61_000);
    const err = await sendQuoteByWhatsApp({ organizationId: a.org, quoteId: "qt_inexistente", userId: a.owner, idempotencyKey: newKey(), now: late }).catch((e) => e);
    expect(err).toBeInstanceOf(QuoteSendError);
    expect(err.code).toBe("rate_limited");
  });

  describe("intentos inciertos (se calculan al leer)", () => {
    async function crashedAttempt(t: Tenant): Promise<{ quoteId: string; sendId: string; linkId: string }> {
      // Simula: el proceso murió tras emitir el enlace y antes de saber qué dijo Meta.
      const quoteId = await draft(t, t.openConv);
      const { d, s } = await mods();
      const { replaceQuoteLinkInTx, generateQuoteToken } = await import("@/server/quotes/links");
      const sendId = `qts_crash${Date.now().toString(36)}${++keySeq}`;
      const old = new Date(Date.now() - 6 * 60_000);
      let linkId = "";
      await d.transaction(async (tx) => {
        linkId = await replaceQuoteLinkInTx(tx, { organizationId: t.org, quoteId, token: generateQuoteToken(), expiresAt: new Date(Date.now() + 86_400_000), now: old });
        await tx.insert(s.quoteSend).values({ id: sendId, organizationId: t.org, quoteId, idempotencyKey: newKey(), status: "pendiente", mode: "documento", quoteLinkId: linkId, sentBy: t.owner, createdAt: old });
      });
      return { quoteId, sendId, linkId };
    }

    it("un pendiente de más de 5 min se lee como incierto y bloquea un reenvío automático", async () => {
      const { getLatestQuoteSend } = await import("@/server/quotes/whatsapp-send");
      const c = await crashedAttempt(a);
      expect((await getLatestQuoteSend(a.org, c.quoteId))!.status).toBe("incierto");
      as(a);
      const r = await routes();
      const res = await r.send(c.quoteId);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("uncertain_pending");
      expect(graph.calls).toHaveLength(0);
    });

    it("'Sí llegó' marca la cotización enviada por WhatsApp", async () => {
      const c = await crashedAttempt(a);
      as(a);
      const r = await routes();
      const res = await r.resolve(c.quoteId, c.sendId, "llego");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { send: { status: string; resolution: string } }).send).toMatchObject({ status: "enviado", resolution: "llego" });
      expect(await quoteRow(c.quoteId)).toMatchObject({ status: "enviada", sentVia: "whatsapp", sentBy: a.owner });
      expect(graph.calls).toHaveLength(0);
    });

    it("'No llegó' revoca el enlace del intento y permite reintentar (un solo envío nuevo)", async () => {
      const c = await crashedAttempt(a);
      as(a);
      const r = await routes();
      const res = await r.resolve(c.quoteId, c.sendId, "no_llego");
      expect(res.status).toBe(200);
      const { d, s, orm } = await mods();
      const [link] = await d.select().from(s.quoteLink).where(orm.eq(s.quoteLink.id, c.linkId));
      expect(link!.revokedAt).not.toBeNull();
      expect((await quoteRow(c.quoteId)).status).toBe("borrador");
      expect((await r.send(c.quoteId)).status).toBe(200);
      expect(messageCalls()).toHaveLength(1);
    });

    it("no se puede resolver un envío que no está incierto", async () => {
      as(a);
      const r = await routes();
      const quoteId = await draft(a, a.openConv);
      expect((await r.send(quoteId)).status).toBe(200);
      const { getLatestQuoteSend } = await import("@/server/quotes/whatsapp-send");
      const sent = (await getLatestQuoteSend(a.org, quoteId))!;
      expect((await r.resolve(quoteId, sent.id, "no_llego")).status).toBe(409);
      expect((await r.resolve(quoteId, sent.id, "quizá")).status).toBe(422);
    });
  });

  it("el bot y el agente no tienen ninguna ruta que envíe cotizaciones", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        if (statSync(file).isDirectory()) walk(file);
        else if (/\.(ts|tsx)$/.test(name) && /whatsapp-send|sendQuoteByWhatsApp|resolveUncertainSend/.test(readFileSync(file, "utf8"))) offenders.push(file);
      }
    };
    walk(join(process.cwd(), "src", "app", "api", "bot"));
    walk(join(process.cwd(), "src", "server", "ai"));
    walk(join(process.cwd(), "src", "server", "bot"));
    expect(offenders).toEqual([]);
  });
});
