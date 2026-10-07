import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatMoneyCents } from "@/lib/money";
import { quotesEnabled } from "@/server/quotes/flag";
import { formatQuantity, formatTaxRate } from "@/server/quotes/pdf";
import { getPublicQuote, type PublicQuote } from "@/server/quotes/public";
import { RespondPanel } from "./respond-panel";

export const dynamic = "force-dynamic";

/**
 * /p/:token — la cotización vista por el cliente, sin cuenta.
 *
 * Todo motivo de "no disponible" (bandera apagada, token mal formado, ajeno,
 * vencido o revocado) termina en el MISMO `notFound()`. Solo se pasan al
 * HTML los campos de `PublicQuote`: ningún id interno llega al navegador.
 */

export const metadata: Metadata = {
  title: "Cotización",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

const STATUS_LABEL: Record<PublicQuote["status"], string> = {
  borrador: "Borrador",
  enviada: "Esperando tu respuesta",
  aceptada: "Aceptada",
  rechazada: "Rechazada",
  expirada: "Vencida",
  cancelada: "Cancelada",
};

function money(cents: number, currency: string): string {
  return formatMoneyCents(cents, currency) ?? `${(cents / 100).toFixed(2)} ${currency}`;
}

function date(iso: string): string {
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(iso));
}

export default async function PublicQuotePage({ params }: { params: Promise<{ token: string }> }) {
  if (!quotesEnabled()) notFound();
  const { token } = await params;
  const found = await getPublicQuote(token);
  if (!found) notFound();
  const { quote } = found;
  const base = `/p/${encodeURIComponent(token)}`;
  const rate = formatTaxRate(quote.taxRateBps);

  return (
    <main className="min-h-dvh bg-background px-4 py-8 sm:py-12">
      <article className="mx-auto w-full max-w-2xl rounded-2xl border bg-background p-5 shadow-sm sm:p-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- servido por token, sin optimizador */}
            <img
              src={`${base}/logo`}
              alt=""
              width={48}
              height={48}
              referrerPolicy="no-referrer"
              className="h-12 w-12 shrink-0 rounded-lg object-contain"
            />
            <h1 className="min-w-0 break-words text-xl font-bold">{quote.business.name}</h1>
          </div>
          <div className="text-right text-sm">
            <p className="font-semibold">Cotización {quote.folio}</p>
            <p className="text-text-3">Fecha: {date(quote.issuedAt)}</p>
            <p className="text-text-3">Vigente hasta: {date(quote.validUntil)}</p>
          </div>
        </header>

        <p className="mt-4 inline-block rounded-full bg-secondary px-3 py-1 text-xs font-semibold">
          {STATUS_LABEL[quote.status]}
        </p>

        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-text-3">
                <th className="py-2 pr-3 font-semibold">Descripción</th>
                <th className="py-2 pr-3 text-right font-semibold">Cant.</th>
                <th className="py-2 pr-3 text-right font-semibold">Precio unitario</th>
                <th className="py-2 text-right font-semibold">Importe</th>
              </tr>
            </thead>
            <tbody>
              {quote.items.map((item, i) => (
                <tr key={i} className="border-b align-top">
                  <td className="whitespace-pre-line break-words py-2 pr-3">{item.description}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatQuantity(Math.round(item.quantity * 1000))}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{money(item.unitPriceCents, quote.currency)}</td>
                  <td className="py-2 text-right tabular-nums">{money(item.lineTotalCents, quote.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <dl className="ml-auto mt-4 w-full max-w-xs space-y-1 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-text-3">{quote.pricesIncludeTax ? "Subtotal (IVA incluido)" : "Subtotal"}</dt>
            <dd className="tabular-nums">{money(quote.subtotalCents, quote.currency)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-text-3">{quote.pricesIncludeTax ? `IVA ${rate} incluido` : `IVA ${rate}`}</dt>
            <dd className="tabular-nums">{money(quote.taxCents, quote.currency)}</dd>
          </div>
          <div className="flex justify-between gap-4 border-t pt-2 text-base font-bold">
            <dt>Total</dt>
            <dd className="tabular-nums">{money(quote.totalCents, quote.currency)}</dd>
          </div>
        </dl>

        <p className="mt-2 text-right text-xs text-text-3">
          Montos en {quote.currency}. Esta cotización no es un comprobante fiscal.
        </p>

        <div className="mt-6">
          <a
            href={`${base}/pdf`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-sm font-semibold text-brand-text underline underline-offset-4"
          >
            Descargar PDF
          </a>
        </div>

        <section className="mt-8 border-t pt-6">
          {quote.status === "enviada" ? (
            <RespondPanel token={token} businessName={quote.business.name} />
          ) : (
            <p className="text-sm text-text-3">
              {quote.status === "aceptada" && "Esta cotización ya fue aceptada."}
              {quote.status === "rechazada" && "Esta cotización fue rechazada."}
              {quote.status === "expirada" && "La vigencia de esta cotización terminó. Pide una actualizada al negocio."}
            </p>
          )}
        </section>
      </article>
    </main>
  );
}
