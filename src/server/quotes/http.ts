import { z } from "zod";
import { QUANTITY_SCALE, quantityToMilli, QuoteAmountError } from "@/server/quotes/totals";
import { MAX_QUOTE_ITEMS, MAX_QUOTE_NOTES, QuoteError, type QuoteView } from "@/server/quotes/service";

/**
 * Contrato HTTP de cotizaciones, en un solo sitio (mismo criterio que
 * `agenda/http.ts`): los códigos y la forma del error son contrato
 * observable. Crear responde 201; el error va anidado `{"error":{code,message}}`.
 */

/**
 * Body de `POST /api/bot/quotes`. `.strict()` a propósito: si un cliente manda
 * `unitPriceCents`, `total` o cualquier monto, la petición se RECHAZA (422) en
 * vez de ignorarlo en silencio — el precio solo sale del catálogo.
 */
export const createQuoteBodySchema = z
  .object({
    conversationId: z.string().min(1).max(100),
    items: z
      .array(
        z
          .object({
            serviceId: z.string().min(1).max(100),
            quantity: z.number().positive().default(1),
          })
          .strict()
      )
      .min(1)
      .max(MAX_QUOTE_ITEMS),
    notes: z.string().max(MAX_QUOTE_NOTES).nullish(),
    validityDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

export type CreateQuoteBody = z.infer<typeof createQuoteBodySchema>;

/** Convierte las cantidades del body a milésimas; lanza QuoteError si alguna no sirve. */
export function itemsToMilli(
  items: readonly { serviceId: string; quantity?: number }[]
): { serviceId: string; quantityMilli: number }[] {
  return items.map((item, index) => {
    try {
      return { serviceId: item.serviceId, quantityMilli: quantityToMilli(item.quantity ?? 1) };
    } catch (err) {
      if (err instanceof QuoteAmountError) {
        throw new QuoteError("invalid", `items.${index}.quantity: ${err.message}`);
      }
      throw err;
    }
  });
}

export function quotePayload(quote: QuoteView) {
  return {
    id: quote.id,
    folio: quote.folio,
    status: quote.status,
    conversationId: quote.conversationId,
    contactId: quote.contactId,
    currency: quote.currency,
    pricesIncludeTax: quote.pricesIncludeTax,
    taxRateBps: quote.taxRateBps,
    subtotalCents: quote.subtotalCents,
    taxCents: quote.taxCents,
    totalCents: quote.totalCents,
    validUntil: quote.validUntil.toISOString(),
    notes: quote.notes,
    source: quote.source,
    isTest: quote.isTest,
    sentAt: quote.sentAt?.toISOString() ?? null,
    respondedAt: quote.respondedAt?.toISOString() ?? null,
    createdAt: quote.createdAt.toISOString(),
    items: quote.items.map((item) => ({
      id: item.id,
      serviceId: item.serviceId,
      description: item.description,
      quantity: item.quantityMilli / QUANTITY_SCALE,
      unitPriceCents: item.unitPriceCents,
      lineTotalCents: item.lineTotalCents,
    })),
  };
}

export function quoteErrorStatus(code: QuoteError["code"]): number {
  switch (code) {
    case "not_found":
      return 404;
    case "invalid":
    case "service_inactive":
    case "currency_mismatch":
      return 422;
  }
}

/** Traduce un `QuoteError` al sobre estándar. Cualquier otro error se relanza. */
export function quoteErrorResponse(err: unknown): Response {
  if (!(err instanceof QuoteError)) throw err;
  const code = err.code === "invalid" ? "invalid_body" : err.code;
  return Response.json(
    { error: { code, message: err.message } },
    { status: quoteErrorStatus(err.code) }
  );
}
