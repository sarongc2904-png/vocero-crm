import { and, asc, eq, exists, gt, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import type { QuoteStatus } from "@/lib/db/schema";
import { publish } from "@/server/events/bus";
import { readMediaFile } from "@/server/whatsapp/media";
import { getBranding } from "@/server/branding";
import { FAVICON_ASSET, generatedFaviconSvg } from "@/lib/favicon";
import { formatQuoteFolio } from "@/server/quotes/numbering";
import { hashQuoteToken, isWellFormedQuoteToken } from "@/server/quotes/links";
import { effectiveQuoteStatus } from "@/server/quotes/service";
import { QUANTITY_SCALE } from "@/server/quotes/totals";

/**
 * Lado público de una cotización: todo entra por el TOKEN, nunca por un id.
 *
 * Un token mal formado, inexistente, de otro negocio, vencido, revocado o de
 * una cotización cancelada dan EXACTAMENTE el mismo resultado (`null` → 404):
 * quien prueba tokens no aprende nada de la respuesta.
 *
 * El enlace de un `borrador` es una VISTA PREVIA: muestra exactamente los
 * mismos campos que la versión enviada, sin botones, y no acepta respuestas.
 *
 * Lo que sale hacia afuera es `PublicQuote`: nombre del negocio, folio,
 * estado, líneas, totales y vigencia. Ningún id interno ni dato del cliente.
 */

export type PublicQuote = {
  business: { name: string };
  folio: string;
  status: QuoteStatus;
  issuedAt: string;
  validUntil: string;
  currency: string;
  pricesIncludeTax: boolean;
  taxRateBps: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  items: { description: string; quantity: number; unitPriceCents: number; lineTotalCents: number }[];
};

/** Lo que el servidor necesita para actuar; jamás se serializa hacia el cliente. */
type ResolvedLink = {
  linkId: string;
  organizationId: string;
  quoteId: string;
};

async function resolveLink(token: string, now: Date): Promise<ResolvedLink | null> {
  // Un token mal formado TAMBIÉN hace la consulta (con un hash que no puede
  // existir): así todo motivo de 404 tarda y se ve igual, incluso en cómo Next
  // trocea el HTML de la página.
  const tokenHash = isWellFormedQuoteToken(token) ? hashQuoteToken(token) : "0".repeat(63) + "x";
  const rows = await getDb()
    .select({
      linkId: schema.quoteLink.id,
      organizationId: schema.quoteLink.organizationId,
      quoteId: schema.quoteLink.quoteId,
    })
    .from(schema.quoteLink)
    .innerJoin(
      schema.quote,
      and(
        eq(schema.quote.organizationId, schema.quoteLink.organizationId),
        eq(schema.quote.id, schema.quoteLink.quoteId)
      )
    )
    .where(
      and(
        eq(schema.quoteLink.tokenHash, tokenHash),
        isNull(schema.quoteLink.revokedAt),
        gt(schema.quoteLink.expiresAt, now),
        // Un borrador SÍ se resuelve: es la vista previa (sin botones).
        sql`${schema.quote.status} <> 'cancelada'`
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export type PublicQuoteView = { quote: PublicQuote; organizationId: string };

/**
 * Cotización visible por su token, o `null`. Registra la última vista
 * (dato interno del enlace, no se expone).
 */
export async function getPublicQuote(token: string, now: Date = new Date()): Promise<PublicQuoteView | null> {
  const link = await resolveLink(token, now);
  if (!link) return null;
  const db = getDb();
  const { organizationId, quoteId } = link;

  const [quoteRows, items, orgRows] = await Promise.all([
    db
      .select()
      .from(schema.quote)
      .where(scoped(schema.quote.organizationId, organizationId, eq(schema.quote.id, quoteId)))
      .limit(1),
    db
      .select({
        description: schema.quoteItem.description,
        quantityMilli: schema.quoteItem.quantityMilli,
        unitPriceCents: schema.quoteItem.unitPriceCents,
        lineTotalCents: schema.quoteItem.lineTotalCents,
      })
      .from(schema.quoteItem)
      .where(scoped(schema.quoteItem.organizationId, organizationId, eq(schema.quoteItem.quoteId, quoteId)))
      .orderBy(asc(schema.quoteItem.position)),
    db
      .select({ name: schema.organization.name })
      .from(schema.organization)
      .where(eq(schema.organization.id, organizationId))
      .limit(1),
  ]);
  const quote = quoteRows[0];
  if (!quote || !orgRows[0]) return null;

  await db
    .update(schema.quoteLink)
    .set({ lastViewedAt: now })
    .where(scoped(schema.quoteLink.organizationId, organizationId, eq(schema.quoteLink.id, link.linkId)));

  return {
    organizationId,
    quote: {
      business: { name: orgRows[0].name },
      folio: formatQuoteFolio(quote.number),
      status: effectiveQuoteStatus(quote, now),
      issuedAt: (quote.sentAt ?? quote.createdAt).toISOString(),
      validUntil: quote.validUntil.toISOString(),
      currency: quote.currency,
      pricesIncludeTax: quote.pricesIncludeTax,
      taxRateBps: quote.taxRateBps,
      subtotalCents: quote.subtotalCents,
      taxCents: quote.taxCents,
      totalCents: quote.totalCents,
      items: items.map((item) => ({
        description: item.description,
        quantity: item.quantityMilli / QUANTITY_SCALE,
        unitPriceCents: item.unitPriceCents,
        lineTotalCents: item.lineTotalCents,
      })),
    },
  };
}

export type PublicLogo = { bytes: Uint8Array; mime: string };

/**
 * Logo del negocio dueño de la cotización: el ícono que subió en Marca o, si
 * no hay, el generado con la inicial de su nombre.
 */
export async function getPublicLogo(organizationId: string, businessName: string): Promise<PublicLogo> {
  const branding = await getBranding(organizationId).catch(() => null);
  if (branding?.favicon) {
    try {
      const buf = await readMediaFile(organizationId, FAVICON_ASSET);
      return { bytes: new Uint8Array(buf), mime: branding.favicon.mime };
    } catch {
      // Archivo perdido: se cae al generado.
    }
  }
  const svg = generatedFaviconSvg({
    name: businessName,
    accent: branding?.accent ?? "#0d5bff",
    currency: branding?.currency ?? "MXN",
    favicon: null,
  });
  return { bytes: new TextEncoder().encode(svg), mime: "image/svg+xml" };
}

export type QuoteDecision = "aceptar" | "rechazar";

export type RespondResult =
  | { outcome: "not_found" }
  | { outcome: "recorded"; status: "aceptada" | "rechazada" }
  /** Vista previa de un borrador: todavía no se puede responder. */
  | { outcome: "not_open" }
  | { outcome: "already"; status: QuoteStatus };

export const MAX_RESPONSE_NOTE = 500;

/**
 * Acepta o rechaza. El ganador lo decide UN solo `UPDATE … WHERE status =
 * 'enviada' AND vigente AND enlace vivo`: si dos personas responden a la vez,
 * Postgres serializa las dos escrituras sobre la fila y la segunda ya no
 * encuentra `enviada`. La nota en el contacto va en la MISMA transacción, así
 * que solo la escribe quien ganó.
 */
export async function respondToQuote(input: {
  token: string;
  decision: QuoteDecision;
  comment?: string | null;
  now?: Date;
}): Promise<RespondResult> {
  const now = input.now ?? new Date();
  const link = await resolveLink(input.token, now);
  if (!link) return { outcome: "not_found" };
  const { organizationId, quoteId, linkId } = link;
  const status = input.decision === "aceptar" ? "aceptada" : "rechazada";
  const comment = input.comment?.trim() ? input.comment.trim().slice(0, MAX_RESPONSE_NOTE) : null;

  const won = await getDb().transaction(async (tx) => {
    const updated = await tx
      .update(schema.quote)
      .set({ status, respondedAt: now, responseNote: comment, updatedAt: now })
      .where(
        scoped(
          schema.quote.organizationId,
          organizationId,
          eq(schema.quote.id, quoteId),
          eq(schema.quote.status, "enviada"),
          gt(schema.quote.validUntil, now),
          exists(
            tx
              .select({ one: sql`1` })
              .from(schema.quoteLink)
              .where(
                and(
                  eq(schema.quoteLink.id, linkId),
                  eq(schema.quoteLink.organizationId, organizationId),
                  isNull(schema.quoteLink.revokedAt),
                  gt(schema.quoteLink.expiresAt, now)
                )
              )
          )
        )
      )
      .returning({
        number: schema.quote.number,
        contactId: schema.quote.contactId,
        totalCents: schema.quote.totalCents,
        currency: schema.quote.currency,
      });
    const row = updated[0];
    if (!row) return null;

    const verb = status === "aceptada" ? "ACEPTADA" : "RECHAZADA";
    const stamp = `[Cotización] ${formatQuoteFolio(row.number)} ${verb} por el cliente desde el enlace${
      comment ? `. Comentario: "${comment.replace(/\s+/g, " ")}"` : ""
    }`;
    await tx
      .update(schema.contact)
      .set({
        notes: sql`case when ${schema.contact.notes} is null or ${schema.contact.notes} = '' then ${stamp} else ${schema.contact.notes} || E'\n' || ${stamp} end`,
        updatedAt: now,
      })
      .where(scoped(schema.contact.organizationId, organizationId, eq(schema.contact.id, row.contactId)));
    await tx
      .update(schema.lead)
      .set({ lastActivityAt: now, updatedAt: now })
      .where(scoped(schema.lead.organizationId, organizationId, eq(schema.lead.contactId, row.contactId)));
    return row;
  });

  if (!won) {
    const current = await getDb()
      .select({ status: schema.quote.status, validUntil: schema.quote.validUntil })
      .from(schema.quote)
      .where(scoped(schema.quote.organizationId, organizationId, eq(schema.quote.id, quoteId)))
      .limit(1);
    const row = current[0];
    if (!row) return { outcome: "not_found" };
    if (row.status === "borrador") return { outcome: "not_open" };
    return { outcome: "already", status: effectiveQuoteStatus(row, now) };
  }

  // Después del commit, como pide el bus.
  publish(organizationId, { type: "quote.updated", data: { quoteId, status } });
  return { outcome: "recorded", status };
}
