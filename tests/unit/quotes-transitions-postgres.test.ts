import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tabla COMPLETA de transiciones de una cotización contra un Postgres real:
 * cada acción del operador y del cliente probada desde cada estado, más los
 * casos borde (marcar enviada sin enlace vivo o vencida, reemitir revoca,
 * el borrador no acepta respuestas, duplicar cancela la enviada).
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

type State = "borrador" | "enviada" | "aceptada" | "rechazada" | "cancelada" | "expirada";
const STATES: State[] = ["borrador", "enviada", "aceptada", "rechazada", "cancelada", "expirada"];

type Ctx = { org: string; user: string; contact: string; conv: string; svc: string; svc2: string };
let ctx: Ctx;
let seq = 0;

async function mods() {
  const { getDb, schema } = await import("@/lib/db");
  return {
    d: getDb(),
    s: schema,
    orm: await import("drizzle-orm"),
    service: await import("@/server/quotes/service"),
    links: await import("@/server/quotes/links"),
    transitions: await import("@/server/quotes/transitions"),
    pub: await import("@/server/quotes/public"),
  };
}

/** Lleva una cotización al estado pedido usando los caminos reales. */
async function quoteIn(state: State): Promise<{ id: string; token: string }> {
  const { d, s, orm, service, links, transitions, pub } = await mods();
  const quote = await service.createDraftQuote({
    organizationId: ctx.org,
    conversationId: ctx.conv,
    items: [{ serviceId: ctx.svc, quantityMilli: 1000 }],
    source: "manual",
  });
  const { token } = await links.issueQuoteLink({ organizationId: ctx.org, quoteId: quote.id });
  if (state === "borrador") return { id: quote.id, token };
  await transitions.markQuoteSent({ organizationId: ctx.org, quoteId: quote.id, userId: ctx.user });
  if (state === "aceptada" || state === "rechazada") {
    const r = await pub.respondToQuote({ token, decision: state === "aceptada" ? "aceptar" : "rechazar" });
    expect(r.outcome).toBe("recorded");
  }
  if (state === "cancelada") await transitions.cancelQuote({ organizationId: ctx.org, quoteId: quote.id });
  if (state === "expirada") {
    const past = new Date(Date.now() - 60_000);
    await d.update(s.quote).set({ validUntil: past }).where(orm.eq(s.quote.id, quote.id));
    await d.update(s.quoteLink).set({ expiresAt: past }).where(orm.eq(s.quoteLink.quoteId, quote.id));
  }
  return { id: quote.id, token };
}

async function storedStatus(id: string): Promise<string> {
  const { d, s, orm } = await mods();
  const [row] = await d.select({ status: s.quote.status }).from(s.quote).where(orm.eq(s.quote.id, id));
  return row!.status;
}

/** "ok" si la acción se aplicó; si no, el código del QuoteError o el outcome. */
async function attempt(run: () => Promise<unknown>): Promise<string> {
  const { service } = await mods();
  try {
    await run();
    return "ok";
  } catch (err) {
    if (err instanceof service.QuoteError) return err.code;
    throw err;
  }
}

describe.skipIf(!PG_URL)("cotizaciones: tabla de transiciones (Postgres real)", () => {
  beforeAll(async () => {
    vi.stubEnv("COTIZACIONES", "on");
    const { d, s } = await mods();
    seq += 1;
    const tag = `${Date.now().toString(36)}${seq}`;
    ctx = {
      org: `org_qx${tag}`,
      user: `usr_qx${tag}`,
      contact: `ct_qx${tag}`,
      conv: `cv_qx${tag}`,
      svc: `svc_qx${tag}`,
      svc2: `svc_qx2${tag}`,
    };
    await d.insert(s.organization).values({ id: ctx.org, name: `Org ${tag}` });
    await d.insert(s.user).values({ id: ctx.user, name: "Operador", email: `${ctx.user}@example.test` });
    await d.insert(s.contact).values({ id: ctx.contact, organizationId: ctx.org, waIdentity: `52188${tag}`, name: "Cliente" });
    await d.insert(s.conversation).values({ id: ctx.conv, organizationId: ctx.org, contactId: ctx.contact });
    await d.insert(s.service).values([
      { id: ctx.svc, organizationId: ctx.org, name: `Servicio ${tag}`, durationMinutes: 60, priceCents: 100000 },
      { id: ctx.svc2, organizationId: ctx.org, name: `Otro ${tag}`, durationMinutes: 60, priceCents: 5000 },
    ]);
  });

  beforeEach(async () => {
    const { resetRateLimit } = await import("@/lib/rate-limit");
    resetRateLimit();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!ctx) return;
    const { d, s, orm } = await mods();
    await d.delete(s.organization).where(orm.eq(s.organization.id, ctx.org));
    await d.delete(s.user).where(orm.eq(s.user.id, ctx.user));
  });

  // Resultado esperado de cada acción desde cada estado.
  const EXPECTED: Record<string, Record<State, string>> = {
    markSent: { borrador: "ok", enviada: "invalid_transition", aceptada: "invalid_transition", rechazada: "invalid_transition", cancelada: "invalid_transition", expirada: "invalid_transition" },
    cancel: { borrador: "ok", enviada: "ok", aceptada: "invalid_transition", rechazada: "invalid_transition", cancelada: "invalid_transition", expirada: "ok" },
    edit: { borrador: "ok", enviada: "invalid_transition", aceptada: "invalid_transition", rechazada: "invalid_transition", cancelada: "invalid_transition", expirada: "invalid_transition" },
    duplicate: { borrador: "invalid_transition", enviada: "ok", aceptada: "ok", rechazada: "ok", cancelada: "ok", expirada: "ok" },
    issueLink: { borrador: "ok", enviada: "ok", aceptada: "invalid", rechazada: "invalid", cancelada: "invalid", expirada: "invalid" },
    respond: { borrador: "not_open", enviada: "recorded", aceptada: "already", rechazada: "already", cancelada: "not_found", expirada: "not_found" },
  };

  for (const action of Object.keys(EXPECTED)) {
    for (const state of STATES) {
      it(`${action} desde ${state} → ${EXPECTED[action]![state]}`, async () => {
        const { service, links, transitions, pub } = await mods();
        const q = await quoteIn(state);
        const before = await storedStatus(q.id);
        const run: Record<string, () => Promise<string>> = {
          markSent: () => attempt(() => transitions.markQuoteSent({ organizationId: ctx.org, quoteId: q.id, userId: ctx.user })),
          cancel: () => attempt(() => transitions.cancelQuote({ organizationId: ctx.org, quoteId: q.id })),
          edit: () =>
            attempt(() =>
              service.updateDraftQuote({ organizationId: ctx.org, quoteId: q.id, items: [{ serviceId: ctx.svc2, quantityMilli: 2000 }] })
            ),
          duplicate: () => attempt(() => transitions.duplicateQuote({ organizationId: ctx.org, quoteId: q.id, userId: ctx.user })),
          issueLink: () => attempt(() => links.issueQuoteLink({ organizationId: ctx.org, quoteId: q.id })),
          respond: async () => (await pub.respondToQuote({ token: q.token, decision: "aceptar" })).outcome,
        };
        const result = await run[action]!();
        expect(result).toBe(EXPECTED[action]![state]);
        // Una acción rechazada no cambia el estado guardado.
        if (result !== "ok" && result !== "recorded") expect(await storedStatus(q.id)).toBe(before);
      });
    }
  }

  it("marcar enviada registra fecha, medio y operador", async () => {
    const { service } = await mods();
    const q = await quoteIn("enviada");
    const view = (await service.getQuote(ctx.org, q.id))!;
    expect(view.status).toBe("enviada");
    expect(view.sentVia).toBe("enlace");
    expect(view.sentBy).toBe(ctx.user);
    expect(view.sentAt).toBeInstanceOf(Date);
  });

  it("marcar enviada sin enlace, con el enlace revocado o con la vigencia vencida falla", async () => {
    const { d, s, orm, service, links, transitions } = await mods();
    const draft = async () =>
      (await service.createDraftQuote({ organizationId: ctx.org, conversationId: ctx.conv, items: [{ serviceId: ctx.svc, quantityMilli: 1000 }], source: "manual" })).id;
    const mark = (id: string) => attempt(() => transitions.markQuoteSent({ organizationId: ctx.org, quoteId: id, userId: ctx.user }));

    const noLink = await draft();
    expect(await mark(noLink)).toBe("invalid_transition");

    const revoked = await draft();
    await links.issueQuoteLink({ organizationId: ctx.org, quoteId: revoked });
    await links.revokeQuoteLinks({ organizationId: ctx.org, quoteId: revoked });
    expect(await mark(revoked)).toBe("invalid_transition");

    const expired = await draft();
    await links.issueQuoteLink({ organizationId: ctx.org, quoteId: expired });
    await d.update(s.quote).set({ validUntil: new Date(Date.now() - 1000) }).where(orm.eq(s.quote.id, expired));
    expect(await mark(expired)).toBe("invalid_transition");

    for (const id of [noLink, revoked, expired]) expect(await storedStatus(id)).toBe("borrador");
  });

  it("la base no permite 'enviada' sin fecha y medio de envío", async () => {
    const { d, s, orm } = await mods();
    const q = await quoteIn("borrador");
    let code: string | undefined;
    try {
      await d.update(s.quote).set({ status: "enviada" }).where(orm.eq(s.quote.id, q.id));
    } catch (err) {
      code = ((err as { cause?: { code?: string } }).cause ?? (err as { code?: string })).code;
    }
    expect(code).toBe("23514");
  });

  it("emitir un enlace no cambia el estado y revoca el anterior", async () => {
    const { links, pub } = await mods();
    const q = await quoteIn("borrador");
    const second = await links.issueQuoteLink({ organizationId: ctx.org, quoteId: q.id });
    expect(await storedStatus(q.id)).toBe("borrador");
    expect(await pub.getPublicQuote(q.token)).toBeNull();
    expect(await pub.getPublicQuote(second.token)).not.toBeNull();
  });

  it("el borrador es vista previa: mismos campos que la enviada, sin aceptar respuestas por la API pública", async () => {
    const { pub } = await mods();
    const draft = await quoteIn("borrador");
    const sent = await quoteIn("enviada");
    const draftView = (await pub.getPublicQuote(draft.token))!;
    const sentView = (await pub.getPublicQuote(sent.token))!;
    expect(draftView.quote.status).toBe("borrador");
    expect(Object.keys(draftView.quote).sort()).toEqual(Object.keys(sentView.quote).sort());

    const respond = await import("@/app/api/p/[token]/respond/route");
    const res = await respond.POST(
      new Request(`http://localhost:3000/api/p/${draft.token}/respond`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9" },
        body: JSON.stringify({ decision: "aceptar" }),
      }),
      { params: Promise.resolve({ token: draft.token }) }
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_open");
    expect(await storedStatus(draft.id)).toBe("borrador");
  });

  it("el PDF de un borrador lleva la marca BORRADOR; el de una enviada no", async () => {
    const pdfRoute = await import("@/app/p/[token]/pdf/route");
    const { extractText } = await import("unpdf");
    const textOf = async (token: string) => {
      const res = await pdfRoute.GET(new Request(`http://localhost:3000/p/${token}/pdf`), { params: Promise.resolve({ token }) });
      expect(res.status).toBe(200);
      return {
        disposition: res.headers.get("content-disposition") ?? "",
        text: (await extractText(new Uint8Array(await res.arrayBuffer()), { mergePages: true })).text as string,
      };
    };
    const draft = await textOf((await quoteIn("borrador")).token);
    expect(draft.text).toContain("BORRADOR");
    expect(draft.text).toContain("no válida para aceptar");
    expect(draft.disposition).toContain("-BORRADOR.pdf");
    const sent = await textOf((await quoteIn("enviada")).token);
    expect(sent.text).not.toContain("BORRADOR");
  });

  it("duplicar una enviada la cancela, revoca su enlace y crea un borrador nuevo con las mismas líneas", async () => {
    const { pub, transitions } = await mods();
    const q = await quoteIn("enviada");
    const { original, copy } = await transitions.duplicateQuote({ organizationId: ctx.org, quoteId: q.id, userId: ctx.user });
    expect(original.status).toBe("cancelada");
    expect(await pub.getPublicQuote(q.token)).toBeNull();
    expect(copy.status).toBe("borrador");
    expect(copy.duplicatedFromId).toBe(q.id);
    expect(copy.folio).not.toBe(original.folio);
    expect(copy.items.map((i) => [i.description, i.quantityMilli, i.unitPriceCents])).toEqual(
      original.items.map((i) => [i.description, i.quantityMilli, i.unitPriceCents])
    );
    expect(copy.sentAt).toBeNull();
  });

  it("editar un borrador vuelve a leer precios del catálogo y recalcula totales", async () => {
    const { service } = await mods();
    const q = await quoteIn("borrador");
    const edited = await service.updateDraftQuote({
      organizationId: ctx.org,
      quoteId: q.id,
      items: [{ serviceId: ctx.svc2, quantityMilli: 3000 }],
      notes: "  Nueva nota  ",
    });
    expect(edited.items).toHaveLength(1);
    expect(edited.items[0]).toMatchObject({ serviceId: ctx.svc2, unitPriceCents: 5000, lineTotalCents: 15000 });
    expect(edited).toMatchObject({ subtotalCents: 15000, taxCents: 2400, totalCents: 17400, notes: "Nueva nota" });
  });
});
