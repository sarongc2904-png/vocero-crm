import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Superficie pública de cotizaciones (/p/[token] y /api/p/[token]/respond)
 * contra un Postgres REAL, con las rutas reales.
 *
 * Fija:
 *  - el token de A nunca muestra datos de B, y nada público lleva ids internos;
 *  - token alterado, inexistente, mal formado, vencido, revocado, de una
 *    cotización cancelada o con la bandera apagada dan el MISMO 404;
 *  - aceptar y rechazar en paralelo deja exactamente un ganador, una nota y
 *    un aviso por SSE;
 *  - con la bandera apagada, 404 y cero escrituras.
 *
 * Opcional: corre solo con `VOCERO_TEST_PG_URL` (base DESCARTABLE con las
 * migraciones aplicadas). Sin la variable se omite; el release gate la exige.
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
  process.env.MEDIA_DIR ??= "./.tmp-test-media";
});

type Tenant = { org: string; name: string; contact: string; conv: string; svc: string };

let seq = 0;
const created: string[] = [];
let ipSeq = 0;

async function db() {
  const { getDb, schema } = await import("@/lib/db");
  const orm = await import("drizzle-orm");
  return { d: getDb(), s: schema, orm };
}

async function seedTenant(label: string): Promise<Tenant> {
  const { d, s } = await db();
  seq += 1;
  const tag = `${Date.now().toString(36)}${seq}`;
  const t: Tenant = {
    org: `org_qp${tag}`,
    name: `${label} ${tag}`,
    contact: `ct_qp${tag}`,
    conv: `cv_qp${tag}`,
    svc: `svc_qp${tag}`,
  };
  created.push(t.org);
  await d.insert(s.organization).values({ id: t.org, name: t.name });
  await d.insert(s.contact).values({ id: t.contact, organizationId: t.org, waIdentity: `52177${tag}`, name: "Cliente", notes: "Nota previa" });
  await d.insert(s.conversation).values({ id: t.conv, organizationId: t.org, contactId: t.contact });
  await d.insert(s.service).values({ id: t.svc, organizationId: t.org, name: `Servicio ${label} ${tag}`, durationMinutes: 60, priceCents: 150000 });
  return t;
}

async function publishedQuote(t: Tenant): Promise<{ quoteId: string; token: string }> {
  const { createDraftQuote } = await import("@/server/quotes/service");
  const { issueQuoteLink } = await import("@/server/quotes/links");
  const quote = await createDraftQuote({
    organizationId: t.org,
    conversationId: t.conv,
    items: [{ serviceId: t.svc, quantityMilli: 1000 }],
    source: "bot",
  });
  const { token } = await issueQuoteLink({ organizationId: t.org, quoteId: quote.id });
  return { quoteId: quote.id, token };
}

function req(path: string, init: { method?: string; body?: unknown } = {}): Request {
  ipSeq += 1;
  return new Request(`http://localhost:3000${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.0.${ipSeq % 250}.${ipSeq % 200}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function routes() {
  const respond = await import("@/app/api/p/[token]/respond/route");
  const pdf = await import("@/app/p/[token]/pdf/route");
  const logo = await import("@/app/p/[token]/logo/route");
  const params = (token: string) => ({ params: Promise.resolve({ token }) });
  return {
    respond: (token: string, body: unknown) =>
      respond.POST(req(`/api/p/${token}/respond`, { method: "POST", body }), params(token)),
    pdf: (token: string) => pdf.GET(req(`/p/${token}/pdf`), params(token)),
    logo: (token: string) => logo.GET(req(`/p/${token}/logo`), params(token)),
  };
}

/** Huella comparable de una respuesta: estado, cuerpo y encabezados. */
async function fingerprint(res: Response): Promise<string> {
  const headers = [...res.headers.entries()].filter(([k]) => k !== "date").sort();
  return JSON.stringify({ status: res.status, body: await res.text(), headers });
}

const INTERNAL_ID = /\b(?:qt|qti|qtl|org|ct|cv|svc|ld|stg)_[a-z0-9]{6,}/;

let a: Tenant;
let b: Tenant;

describe.skipIf(!PG_URL)("cotizaciones: superficie pública (Postgres real)", () => {
  beforeAll(async () => {
    vi.stubEnv("COTIZACIONES", "on");
    a = await seedTenant("Negocio A");
    b = await seedTenant("Negocio B");
  });

  beforeEach(async () => {
    vi.stubEnv("COTIZACIONES", "on");
    const { resetRateLimit } = await import("@/lib/rate-limit");
    resetRateLimit();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (created.length === 0) return;
    const { d, s, orm } = await db();
    await d.delete(s.organization).where(orm.inArray(s.organization.id, created));
  });

  it("el token se muestra una vez: 43 caracteres base64url y en la base solo su SHA-256", async () => {
    const { token, quoteId } = await publishedQuote(a);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    const { d, s, orm } = await db();
    const { hashQuoteToken } = await import("@/server/quotes/links");
    const links = await d.select().from(s.quoteLink).where(orm.eq(s.quoteLink.quoteId, quoteId));
    expect(links).toHaveLength(1);
    expect(links[0]!.tokenHash).toBe(hashQuoteToken(token));
    expect(JSON.stringify(links)).not.toContain(token);
  });

  it("el token de A solo muestra datos de A, sin ids internos", async () => {
    const { getPublicQuote } = await import("@/server/quotes/public");
    const qa = await publishedQuote(a);
    await publishedQuote(b);
    const found = await getPublicQuote(qa.token);
    expect(found).not.toBeNull();
    const json = JSON.stringify(found!.quote);
    expect(found!.quote.business.name).toBe(a.name);
    expect(json).not.toContain(b.name);
    expect(json).not.toMatch(INTERNAL_ID);
    expect(Object.keys(found!.quote).sort()).toEqual(
      ["business", "currency", "folio", "issuedAt", "items", "pricesIncludeTax", "status", "subtotalCents", "taxCents", "taxRateBps", "totalCents", "validUntil"].sort()
    );

    const r = await routes();
    const pdf = await r.pdf(qa.token);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    const { extractText } = await import("unpdf");
    const { text } = await extractText(new Uint8Array(await pdf.arrayBuffer()), { mergePages: true });
    expect(text).toContain(a.name);
    expect(text).not.toContain(b.name);
    expect(text).not.toMatch(INTERNAL_ID);
  });

  it("todo token que no sirve da el MISMO 404, en las tres rutas", async () => {
    const r = await routes();
    const valid = await publishedQuote(a);
    const flipped = valid.token.slice(0, -1) + (valid.token.endsWith("A") ? "B" : "A");

    const revoked = await publishedQuote(a);
    const { revokeQuoteLinks } = await import("@/server/quotes/links");
    await revokeQuoteLinks({ organizationId: a.org, quoteId: revoked.quoteId });

    const expired = await publishedQuote(a);
    const { d, s, orm } = await db();
    await d.update(s.quoteLink).set({ expiresAt: new Date(Date.now() - 1000) }).where(orm.eq(s.quoteLink.quoteId, expired.quoteId));

    const cancelled = await publishedQuote(a);
    await d.update(s.quote).set({ status: "cancelada" }).where(orm.eq(s.quote.id, cancelled.quoteId));

    const bad = {
      alterado: flipped,
      inexistente: "A".repeat(43),
      malFormado: "no-es-un-token",
      vencido: expired.token,
      revocado: revoked.token,
      cancelada: cancelled.token,
    };

    for (const kind of ["pdf", "logo", "respond"] as const) {
      const call = (token: string) => (kind === "respond" ? r.respond(token, { decision: "aceptar" }) : r[kind](token));
      const reference = await fingerprint(await call(bad.inexistente));
      expect(JSON.parse(reference).status).toBe(404);
      for (const [label, token] of Object.entries(bad)) {
        expect(await fingerprint(await call(token)), `${kind}/${label}`).toBe(reference);
      }
      vi.stubEnv("COTIZACIONES", "");
      expect(await fingerprint(await call(valid.token)), `${kind}/bandera apagada`).toBe(reference);
      vi.stubEnv("COTIZACIONES", "on");
    }

    // Ninguna de esas respuestas cambió el estado de las cotizaciones.
    const rows = await d.select({ status: s.quote.status }).from(s.quote).where(orm.inArray(s.quote.id, [valid.quoteId, revoked.quoteId, expired.quoteId]));
    for (const row of rows) expect(row.status).toBe("enviada");
  });

  it("respuestas 200 y 404 llevan noindex, no-store y no-referrer", async () => {
    const r = await routes();
    const { token } = await publishedQuote(a);
    for (const res of [await r.pdf(token), await r.logo(token), await r.pdf("A".repeat(43)), await r.respond("x", { decision: "aceptar" })]) {
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-robots-tag")).toContain("noindex");
    }
  });

  it("10 respuestas simultáneas (aceptar y rechazar): exactamente un ganador, una nota, un aviso", async () => {
    const { respondToQuote } = await import("@/server/quotes/public");
    const { subscribe } = await import("@/server/events/bus");
    const { token, quoteId } = await publishedQuote(a);
    const events: unknown[] = [];
    const off = subscribe(a.org, (e) => {
      if (e.type === "quote.updated") events.push(e);
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          respondToQuote({ token, decision: i % 2 === 0 ? "aceptar" : "rechazar", comment: `intento ${i}` })
        )
      );
      const winners = results.filter((r) => r.outcome === "recorded");
      expect(winners).toHaveLength(1);
      expect(results.filter((r) => r.outcome === "already")).toHaveLength(9);
      const winner = winners[0] as { status: "aceptada" | "rechazada" };

      const { d, s, orm } = await db();
      const [row] = await d.select().from(s.quote).where(orm.eq(s.quote.id, quoteId));
      expect(row!.status).toBe(winner.status);
      expect(row!.respondedAt).not.toBeNull();

      const [contact] = await d.select({ notes: s.contact.notes }).from(s.contact).where(orm.eq(s.contact.id, a.contact));
      const folio = (await import("@/server/quotes/numbering")).formatQuoteFolio(row!.number);
      const lines = contact!.notes!.split("\n").filter((l) => l.includes(`[Cotización] ${folio} `));
      expect(lines).toHaveLength(1);
      expect(contact!.notes!.startsWith("Nota previa\n")).toBe(true);

      expect(events).toEqual([{ type: "quote.updated", data: { quoteId, status: winner.status } }]);
    } finally {
      off();
    }
  });

  it("por HTTP: respuestas en paralelo dan un 200 y el resto 409; después todo es 409", async () => {
    const r = await routes();
    const { token } = await publishedQuote(a);
    const responses = await Promise.all(
      ["aceptar", "rechazar", "aceptar", "rechazar"].map((decision) => r.respond(token, { decision }))
    );
    const statuses = responses.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409]);
    const again = await r.respond(token, { decision: "rechazar" });
    expect(again.status).toBe(409);
  });

  it("el body solo acepta decisión y comentario", async () => {
    const r = await routes();
    const { token } = await publishedQuote(a);
    expect((await r.respond(token, { decision: "aceptar", status: "aceptada" })).status).toBe(422);
    expect((await r.respond(token, { decision: "tal vez" })).status).toBe(422);
    expect((await r.respond(token, { decision: "aceptar", comment: "x".repeat(501) })).status).toBe(422);
  });

  it("límite de peticiones: el sexto intento por enlace en un minuto es 429", async () => {
    const r = await routes();
    const { token } = await publishedQuote(a);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await r.respond(token, { decision: "tal vez" })).status);
    expect(statuses.slice(0, 5)).toEqual([422, 422, 422, 422, 422]);
    expect(statuses[5]).toBe(429);
  });

  it("reemitir revoca el enlace anterior; revocar deja todos en 404", async () => {
    const { getPublicQuote } = await import("@/server/quotes/public");
    const { issueQuoteLink, revokeQuoteLinks } = await import("@/server/quotes/links");
    const first = await publishedQuote(a);
    const second = await issueQuoteLink({ organizationId: a.org, quoteId: first.quoteId });
    expect(await getPublicQuote(first.token)).toBeNull();
    expect(await getPublicQuote(second.token)).not.toBeNull();
    expect((await revokeQuoteLinks({ organizationId: a.org, quoteId: first.quoteId })).revoked).toBe(1);
    expect(await getPublicQuote(second.token)).toBeNull();
  });

  it("A no puede emitir ni revocar enlaces de cotizaciones de B", async () => {
    const { issueQuoteLink, revokeQuoteLinks } = await import("@/server/quotes/links");
    const { QuoteError } = await import("@/server/quotes/service");
    const qb = await publishedQuote(b);
    await expect(issueQuoteLink({ organizationId: a.org, quoteId: qb.quoteId })).rejects.toBeInstanceOf(QuoteError);
    await expect(revokeQuoteLinks({ organizationId: a.org, quoteId: qb.quoteId })).rejects.toBeInstanceOf(QuoteError);
    const { getPublicQuote } = await import("@/server/quotes/public");
    expect(await getPublicQuote(qb.token)).not.toBeNull();
  });

  it("con la bandera apagada: 404 en todo y cero escrituras", async () => {
    const r = await routes();
    const { token, quoteId } = await publishedQuote(a);
    const { d, s, orm } = await db();
    const snapshot = async () =>
      JSON.stringify({
        quote: await d.select().from(s.quote).where(orm.eq(s.quote.id, quoteId)),
        links: await d.select().from(s.quoteLink).where(orm.eq(s.quoteLink.quoteId, quoteId)),
        contact: await d.select().from(s.contact).where(orm.eq(s.contact.id, a.contact)),
      });
    const before = await snapshot();

    vi.stubEnv("COTIZACIONES", "");
    expect((await r.respond(token, { decision: "aceptar" })).status).toBe(404);
    expect((await r.pdf(token)).status).toBe(404);
    expect((await r.logo(token)).status).toBe(404);

    expect(await snapshot()).toBe(before);
  });
});
