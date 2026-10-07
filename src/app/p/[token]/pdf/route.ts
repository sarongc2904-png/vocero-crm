import { quotesEnabled } from "@/server/quotes/flag";
import { renderQuotePdf } from "@/server/quotes/pdf";
import { getPublicLogo, getPublicQuote } from "@/server/quotes/public";
import {
  logPublicError,
  publicNotFound,
  publicRateLimited,
  PUBLIC_HEADERS,
} from "@/server/quotes/public-http";

export const dynamic = "force-dynamic";

/** GET /p/:token/pdf — el PDF de la cotización, con el mismo contenido que la página. */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  if (!quotesEnabled()) return publicNotFound();
  const { token } = await ctx.params;
  const limited = publicRateLimited(req, token, "view");
  if (limited) return limited;

  try {
    const found = await getPublicQuote(token);
    if (!found) return publicNotFound();
    const { quote, organizationId } = found;
    const logo = await getPublicLogo(organizationId, quote.business.name);

    const bytes = await renderQuotePdf({
      business: { name: quote.business.name, logo },
      folio: quote.folio,
      issuedAt: new Date(quote.issuedAt),
      validUntil: new Date(quote.validUntil),
      currency: quote.currency,
      pricesIncludeTax: quote.pricesIncludeTax,
      taxRateBps: quote.taxRateBps,
      subtotalCents: quote.subtotalCents,
      taxCents: quote.taxCents,
      totalCents: quote.totalCents,
      items: quote.items.map((item) => ({
        description: item.description,
        quantityMilli: Math.round(item.quantity * 1000),
        unitPriceCents: item.unitPriceCents,
        lineTotalCents: item.lineTotalCents,
      })),
    });

    return new Response(new Uint8Array(bytes), {
      headers: {
        ...PUBLIC_HEADERS,
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="Cotizacion-${quote.folio}.pdf"`,
      },
    });
  } catch (err) {
    logPublicError("pdf", err);
    return new Response(null, { status: 500, headers: PUBLIC_HEADERS });
  }
}
