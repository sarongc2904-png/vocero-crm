import Link from "next/link";
import { notFound } from "next/navigation";
import { QuoteDetail } from "@/components/quotes/quote-detail";
import { getQuoteDetailForCrm, getQuoteFormOptions } from "@/server/quotes/crm";
import { requireQuotesPage } from "@/server/quotes/page-access";

export const dynamic = "force-dynamic";

export default async function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { session, can } = await requireQuotesPage("quotes.read");
  const { id } = await params;
  // De otro negocio o inexistente: la misma pantalla de "no existe".
  const detail = await getQuoteDetailForCrm(session.organizationId, id);
  if (!detail) notFound();

  const { quote } = detail;
  const editorOptions =
    can.manage && quote.status === "borrador" ? await getQuoteFormOptions(session.organizationId) : null;
  const iso = (d: Date | null) => d?.toISOString() ?? null;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b px-4 py-3 sm:px-6 sm:py-4">
        <p className="text-xs text-text-3">
          <Link href="/quotes" className="underline">
            Cotizaciones
          </Link>{" "}
          / {quote.folio}
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="max-w-3xl">
          <QuoteDetail
            can={can}
            editorOptions={
              editorOptions && {
                conversations: [],
                services: editorOptions.services,
                settings: editorOptions.settings,
              }
            }
            quote={{
              id: quote.id,
              folio: quote.folio,
              status: quote.status,
              contactId: quote.contactId,
              contactName: detail.contactName,
              conversationId: quote.conversationId,
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
              createdAt: quote.createdAt.toISOString(),
              createdByName: detail.createdByName,
              sentAt: iso(quote.sentAt),
              sentVia: quote.sentVia,
              sentByName: detail.sentByName,
              respondedAt: iso(quote.respondedAt),
              responseNote: quote.responseNote,
              items: quote.items.map((item) => ({
                serviceId: item.serviceId,
                description: item.description,
                quantityMilli: item.quantityMilli,
                unitPriceCents: item.unitPriceCents,
                lineTotalCents: item.lineTotalCents,
              })),
              link: {
                active: detail.link.active,
                expiresAt: iso(detail.link.expiresAt),
                lastViewedAt: iso(detail.link.lastViewedAt),
                issuedAt: iso(detail.link.issuedAt),
              },
              duplicatedFrom: detail.duplicatedFrom,
              duplicates: detail.duplicates,
              latestSend: detail.latestSend
                ? {
                    id: detail.latestSend.id,
                    status: detail.latestSend.status,
                    mode: detail.latestSend.mode,
                    errorMessage: detail.latestSend.errorMessage,
                    createdAt: detail.latestSend.createdAt.toISOString(),
                  }
                : null,
            }}
          />
        </div>
      </div>
    </div>
  );
}
