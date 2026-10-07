import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import type { QuoteStatus } from "@/lib/db/schema";
import { formatQuoteFolio, takeNextQuoteNumber } from "@/server/quotes/numbering";
import { getQuoteSettings } from "@/server/quotes/settings";
import { computeQuoteTotals, lineTotalCents, QuoteAmountError } from "@/server/quotes/totals";

/**
 * Cotizaciones: alta de borradores y lectura.
 *
 * Reglas que este módulo garantiza para TODO llamador (API del bot hoy; la
 * pantalla y el agente después):
 *  - El `organizationId` lo pone el llamador desde una fuente confiable (la
 *    API key o la sesión), nunca desde el body. Toda consulta pasa por
 *    `scoped()` y toda referencia que llega del cliente se busca DENTRO del
 *    negocio: un id ajeno es indistinguible de uno inexistente (404).
 *  - El precio SIEMPRE sale del catálogo en la base. El cliente manda qué
 *    servicio y cuántos; nunca un monto.
 *  - Los totales los calcula el servidor (`totals.ts`) y la base los vuelve a
 *    verificar (`quote_total_ck`).
 */

export const MAX_QUOTE_ITEMS = 50;
export const MAX_QUOTE_NOTES = 2000;

export class QuoteError extends Error {
  constructor(
    readonly code: "not_found" | "invalid" | "service_inactive" | "currency_mismatch",
    message: string
  ) {
    super(message);
    this.name = "QuoteError";
  }
}

export type QuoteItemView = {
  id: string;
  serviceId: string | null;
  position: number;
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  lineTotalCents: number;
};

export type QuoteView = {
  id: string;
  folio: string;
  number: number;
  status: QuoteStatus;
  contactId: string;
  conversationId: string | null;
  leadId: string | null;
  currency: string;
  pricesIncludeTax: boolean;
  taxRateBps: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  validUntil: Date;
  notes: string | null;
  source: "manual" | "bot" | "ai";
  isTest: boolean;
  sentAt: Date | null;
  respondedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  items: QuoteItemView[];
};

/**
 * Estado que se MUESTRA. Una cotización enviada cuya vigencia ya pasó se lee
 * como `expirada` aunque nadie la haya actualizado: así no hace falta un
 * proceso programado y nadie puede aceptar una cotización vencida.
 */
export function effectiveQuoteStatus(
  quote: { status: QuoteStatus; validUntil: Date },
  now: Date = new Date()
): QuoteStatus {
  if (quote.status === "enviada" && quote.validUntil.getTime() <= now.getTime()) {
    return "expirada";
  }
  return quote.status;
}

export type CreateDraftInput = {
  organizationId: string;
  conversationId: string;
  items: { serviceId: string; quantityMilli: number }[];
  notes?: string | null;
  validityDays?: number;
  source: "manual" | "bot" | "ai";
  createdBy?: string | null;
  now?: Date;
};

/** Crea una cotización en `borrador` para la conversación indicada. */
export async function createDraftQuote(input: CreateDraftInput): Promise<QuoteView> {
  const { organizationId } = input;
  if (!organizationId) throw new Error("createDraftQuote(): organizationId vacío");
  if (input.items.length === 0) {
    throw new QuoteError("invalid", "La cotización necesita al menos una línea");
  }
  if (input.items.length > MAX_QUOTE_ITEMS) {
    throw new QuoteError("invalid", `Máximo ${MAX_QUOTE_ITEMS} líneas por cotización`);
  }
  const notes = input.notes?.trim() ? input.notes.trim() : null;
  if (notes && notes.length > MAX_QUOTE_NOTES) {
    throw new QuoteError("invalid", `Las notas admiten hasta ${MAX_QUOTE_NOTES} caracteres`);
  }

  const db = getDb();
  const now = input.now ?? new Date();

  const quoteId = await db.transaction(async (tx) => {
    const conversations = await tx
      .select({
        id: schema.conversation.id,
        contactId: schema.conversation.contactId,
        isTest: schema.conversation.isTest,
      })
      .from(schema.conversation)
      .where(
        scoped(
          schema.conversation.organizationId,
          organizationId,
          eq(schema.conversation.id, input.conversationId)
        )
      )
      .limit(1);
    const conversation = conversations[0];
    if (!conversation) throw new QuoteError("not_found", "Conversación no encontrada");

    const serviceIds = [...new Set(input.items.map((item) => item.serviceId))];
    const services = await tx
      .select({
        id: schema.service.id,
        name: schema.service.name,
        priceCents: schema.service.priceCents,
        currency: schema.service.currency,
        active: schema.service.active,
      })
      .from(schema.service)
      .where(
        scoped(schema.service.organizationId, organizationId, inArray(schema.service.id, serviceIds))
      );
    const byId = new Map(services.map((service) => [service.id, service]));
    for (const id of serviceIds) {
      const service = byId.get(id);
      // Ajeno o inexistente: misma respuesta, sin revelar cuál de los dos.
      if (!service) throw new QuoteError("not_found", "Servicio no encontrado");
      if (!service.active) {
        throw new QuoteError("service_inactive", `El servicio "${service.name}" no está activo`);
      }
    }
    const currencies = new Set(services.map((service) => service.currency));
    if (currencies.size > 1) {
      throw new QuoteError(
        "currency_mismatch",
        "Todas las líneas de una cotización deben estar en la misma moneda"
      );
    }
    const currency = services[0]!.currency;

    let lines: Omit<QuoteItemView, "id">[];
    try {
      lines = input.items.map((item, position) => {
        const service = byId.get(item.serviceId)!;
        return {
          serviceId: service.id,
          position,
          description: service.name.slice(0, 500),
          quantityMilli: item.quantityMilli,
          unitPriceCents: service.priceCents,
          lineTotalCents: lineTotalCents(item.quantityMilli, service.priceCents),
        };
      });
    } catch (err) {
      if (err instanceof QuoteAmountError) throw new QuoteError("invalid", err.message);
      throw err;
    }

    const settings = await getQuoteSettings(organizationId, tx);
    const totals = computeQuoteTotals({
      lineTotalsCents: lines.map((line) => line.lineTotalCents),
      pricesIncludeTax: settings.pricesIncludeTax,
      taxRateBps: settings.taxRateBps,
    });
    const validityDays = input.validityDays ?? settings.defaultValidityDays;
    if (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > 365) {
      throw new QuoteError("invalid", "La vigencia debe estar entre 1 y 365 días");
    }

    const leads = await tx
      .select({ id: schema.lead.id })
      .from(schema.lead)
      .where(
        scoped(schema.lead.organizationId, organizationId, eq(schema.lead.contactId, conversation.contactId))
      )
      .limit(1);

    const number = await takeNextQuoteNumber(tx, organizationId);
    const id = newId("quote");
    await tx.insert(schema.quote).values({
      id,
      organizationId,
      contactId: conversation.contactId,
      conversationId: conversation.id,
      leadId: leads[0]?.id ?? null,
      number,
      status: "borrador",
      currency,
      pricesIncludeTax: settings.pricesIncludeTax,
      taxRateBps: settings.taxRateBps,
      subtotalCents: totals.subtotalCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
      validUntil: new Date(now.getTime() + validityDays * 86_400_000),
      notes,
      source: input.source,
      isTest: conversation.isTest,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(schema.quoteItem).values(
      lines.map((line) => ({ id: newId("quoteItem"), organizationId, quoteId: id, ...line }))
    );
    return id;
  });

  const created = await getQuote(organizationId, quoteId);
  if (!created) throw new Error("createDraftQuote(): la cotización recién creada no se encontró");
  return created;
}

/** Una cotización con sus líneas, SOLO si pertenece al negocio. */
export async function getQuote(organizationId: string, quoteId: string): Promise<QuoteView | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.quote)
    .where(scoped(schema.quote.organizationId, organizationId, eq(schema.quote.id, quoteId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const items = await db
    .select()
    .from(schema.quoteItem)
    .where(
      scoped(schema.quoteItem.organizationId, organizationId, eq(schema.quoteItem.quoteId, row.id))
    )
    .orderBy(asc(schema.quoteItem.position));
  return toView(row, items);
}

/** Cotizaciones del negocio, opcionalmente de una conversación, más recientes primero. */
export async function listQuotes(
  organizationId: string,
  filter: { conversationId?: string; limit?: number } = {}
): Promise<QuoteView[]> {
  const db = getDb();
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 20), 1), 100);
  if (filter.conversationId) {
    // Filtrar por una conversación ajena es 404, no una lista vacía.
    const owned = await db
      .select({ id: schema.conversation.id })
      .from(schema.conversation)
      .where(
        scoped(
          schema.conversation.organizationId,
          organizationId,
          eq(schema.conversation.id, filter.conversationId)
        )
      )
      .limit(1);
    if (!owned[0]) throw new QuoteError("not_found", "Conversación no encontrada");
  }
  const rows = await db
    .select()
    .from(schema.quote)
    .where(
      scoped(
        schema.quote.organizationId,
        organizationId,
        filter.conversationId ? eq(schema.quote.conversationId, filter.conversationId) : undefined
      )
    )
    .orderBy(desc(schema.quote.createdAt), desc(schema.quote.number))
    .limit(limit);
  if (rows.length === 0) return [];
  const items = await db
    .select()
    .from(schema.quoteItem)
    .where(
      and(
        scoped(schema.quoteItem.organizationId, organizationId),
        inArray(
          schema.quoteItem.quoteId,
          rows.map((row) => row.id)
        )
      )
    )
    .orderBy(asc(schema.quoteItem.position));
  return rows.map((row) => toView(row, items.filter((item) => item.quoteId === row.id)));
}

function toView(
  row: typeof schema.quote.$inferSelect,
  items: (typeof schema.quoteItem.$inferSelect)[]
): QuoteView {
  return {
    id: row.id,
    folio: formatQuoteFolio(row.number),
    number: row.number,
    status: effectiveQuoteStatus(row),
    contactId: row.contactId,
    conversationId: row.conversationId,
    leadId: row.leadId,
    currency: row.currency,
    pricesIncludeTax: row.pricesIncludeTax,
    taxRateBps: row.taxRateBps,
    subtotalCents: row.subtotalCents,
    taxCents: row.taxCents,
    totalCents: row.totalCents,
    validUntil: row.validUntil,
    notes: row.notes,
    source: row.source,
    isTest: row.isTest,
    sentAt: row.sentAt,
    respondedAt: row.respondedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    items: items.map((item) => ({
      id: item.id,
      serviceId: item.serviceId,
      position: item.position,
      description: item.description,
      quantityMilli: item.quantityMilli,
      unitPriceCents: item.unitPriceCents,
      lineTotalCents: item.lineTotalCents,
    })),
  };
}
