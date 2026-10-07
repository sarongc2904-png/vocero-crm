import Link from "next/link";
import { QuoteStatusBadge } from "@/components/quotes/quote-status-badge";
import { formatMoneyCents } from "@/lib/money";
import { formatQuoteDate } from "@/lib/quote-format";
import { isQuoteListFilter, listQuotesForCrm, type QuoteListFilter } from "@/server/quotes/crm";
import { requireQuotesPage } from "@/server/quotes/page-access";

export const dynamic = "force-dynamic";

const FILTERS: { value: QuoteListFilter; label: string }[] = [
  { value: "todas", label: "Todas" },
  { value: "bot", label: "Del bot por revisar" },
  { value: "borrador", label: "Borradores" },
  { value: "enviada", label: "Enviadas" },
  { value: "aceptada", label: "Aceptadas" },
  { value: "rechazada", label: "Rechazadas" },
  { value: "expirada", label: "Vencidas" },
  { value: "cancelada", label: "Canceladas" },
];

export default async function QuotesPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const { session, can } = await requireQuotesPage("quotes.read");
  const raw = (await searchParams).filter;
  const filter: QuoteListFilter = isQuoteListFilter(raw) ? raw : "todas";
  const [rows, botDrafts] = await Promise.all([
    listQuotesForCrm(session.organizationId, { filter }),
    listQuotesForCrm(session.organizationId, { filter: "bot", limit: 200 }),
  ]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-6 sm:py-4">
        <h2 className="text-[17px] font-bold tracking-tight">Cotizaciones</h2>
        {can.manage && (
          <Link
            href="/quotes/new"
            className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-brand-hover"
          >
            Nueva cotización
          </Link>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <nav aria-label="Filtrar cotizaciones" className="mb-4 flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <Link
              key={f.value}
              href={f.value === "todas" ? "/quotes" : `/quotes?filter=${f.value}`}
              aria-current={filter === f.value ? "page" : undefined}
              className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                filter === f.value ? "border-transparent bg-brand-tint text-brand-text" : "text-text-2 hover:bg-accent"
              }`}
            >
              {f.label}
              {f.value === "bot" && botDrafts.length > 0 ? ` (${botDrafts.length})` : ""}
            </Link>
          ))}
        </nav>

        {rows.length === 0 ? (
          <p className="text-sm text-text-3">No hay cotizaciones con este filtro.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-text-3">
                  <th className="px-3 py-2 font-semibold">Folio</th>
                  <th className="px-3 py-2 font-semibold">Cliente</th>
                  <th className="px-3 py-2 font-semibold">Estado</th>
                  <th className="px-3 py-2 text-right font-semibold">Total</th>
                  <th className="px-3 py-2 font-semibold">Vigencia</th>
                  <th className="px-3 py-2 font-semibold">Origen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b last:border-0 hover:bg-accent">
                    <td className="px-3 py-2 font-semibold">
                      <Link href={`/quotes/${row.id}`} className="underline-offset-4 hover:underline">
                        {row.folio}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{row.contactName}</td>
                    <td className="px-3 py-2">
                      <QuoteStatusBadge status={row.status} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMoneyCents(row.totalCents, row.currency)}
                    </td>
                    <td className="px-3 py-2 text-text-3">{formatQuoteDate(row.validUntil)}</td>
                    <td className="px-3 py-2 text-text-3">
                      {row.source === "bot" ? "Bot" : row.source === "ai" ? "Agente IA" : "Equipo"}
                      {row.isTest ? " · Lab" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
