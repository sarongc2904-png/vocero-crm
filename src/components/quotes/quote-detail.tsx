"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEvents } from "@/components/use-events";
import { QuoteEditor, type EditorOptions } from "@/components/quotes/quote-editor";
import { QuoteStatusBadge } from "@/components/quotes/quote-status-badge";
import { WhatsAppSendPanel, type LatestSend } from "@/components/quotes/whatsapp-send-panel";
import { formatMoneyCents } from "@/lib/money";
import { formatQuantity, formatQuoteDate, formatTaxRate, type QuoteStatusValue } from "@/lib/quote-format";

export type QuoteDetailData = {
  id: string;
  folio: string;
  status: QuoteStatusValue;
  contactId: string;
  contactName: string;
  conversationId: string | null;
  currency: string;
  pricesIncludeTax: boolean;
  taxRateBps: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  validUntil: string;
  notes: string | null;
  source: "manual" | "bot" | "ai";
  isTest: boolean;
  createdAt: string;
  createdByName: string | null;
  sentAt: string | null;
  sentVia: "enlace" | "whatsapp" | null;
  sentByName: string | null;
  respondedAt: string | null;
  responseNote: string | null;
  items: { serviceId: string | null; description: string; quantityMilli: number; unitPriceCents: number; lineTotalCents: number }[];
  link: { active: boolean; expiresAt: string | null; lastViewedAt: string | null; issuedAt: string | null };
  duplicatedFrom: { id: string; folio: string } | null;
  duplicates: { id: string; folio: string; status: QuoteStatusValue }[];
  latestSend: LatestSend | null;
};

type Can = { manage: boolean; publish: boolean };

const SOURCE_LABEL = { manual: "el equipo", bot: "el bot (API)", ai: "el agente IA" } as const;

export function QuoteDetail({ quote, can, editorOptions }: { quote: QuoteDetailData; can: Can; editorOptions: EditorOptions | null }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** El enlace en claro existe SOLO en esta variable, tras emitirlo. */
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEvents({
    onQuoteUpdated: (d) => {
      if (d.quoteId === quote.id) router.refresh();
    },
  });

  const money = (cents: number) => formatMoneyCents(cents, quote.currency) ?? String(cents / 100);
  const editable = quote.status === "borrador";
  const canIssueLink = can.publish && (quote.status === "borrador" || quote.status === "enviada");

  async function act(name: string, path: string, method: "POST" | "DELETE", confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return null;
    setError(null);
    setBusy(name);
    try {
      const res = await fetch(`/api/quotes/${quote.id}/${path}`, { method });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        setError((data?.error as { message?: string } | undefined)?.message ?? "No se pudo completar la acción");
        return null;
      }
      return data;
    } finally {
      setBusy(null);
    }
  }

  async function issueLink() {
    const data = await act(
      "link",
      "link",
      "POST",
      quote.link.active ? "Se generará un enlace NUEVO y el anterior dejará de funcionar. ¿Continuar?" : undefined
    );
    if (!data) return;
    setIssuedUrl(String(data.url));
    setCopied(false);
    router.refresh();
  }

  async function copy() {
    if (!issuedUrl) return;
    try {
      await navigator.clipboard.writeText(issuedUrl);
      setCopied(true);
    } catch {
      setError("No se pudo copiar; selecciona el enlace y cópialo a mano.");
    }
  }

  async function revoke() {
    if (await act("revoke", "link", "DELETE", "El cliente ya no podrá abrir la cotización con el enlace actual. ¿Revocarlo?")) {
      setIssuedUrl(null);
      router.refresh();
    }
  }

  async function markSent() {
    if (await act("sent", "mark-sent", "POST", "¿Confirmas que ya le compartiste el enlace al cliente por otro medio?")) {
      router.refresh();
    }
  }

  async function cancel() {
    if (await act("cancel", "cancel", "POST", "La cotización quedará cancelada y su enlace dejará de funcionar. ¿Cancelarla?")) {
      setIssuedUrl(null);
      router.refresh();
    }
  }

  async function duplicate() {
    const warn =
      quote.status === "enviada"
        ? "Se CANCELARÁ esta cotización (su enlace deja de funcionar) y se creará un borrador nuevo con las mismas líneas. ¿Continuar?"
        : "Se creará un borrador nuevo con las mismas líneas. ¿Continuar?";
    const data = await act("duplicate", "duplicate", "POST", warn);
    const copyId = (data?.copy as { id?: string } | undefined)?.id;
    if (copyId) router.push(`/quotes/${copyId}`);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold">{quote.folio}</h2>
            <QuoteStatusBadge status={quote.status} />
            {quote.isTest && <span className="text-xs text-text-3">(Laboratorio)</span>}
          </div>
          <p className="mt-1 text-sm text-text-3">
            Para{" "}
            <Link href={`/inbox?contact=${quote.contactId}`} className="font-semibold text-foreground underline">
              {quote.contactName}
            </Link>{" "}
            · creada por {quote.createdByName ?? SOURCE_LABEL[quote.source]} el {formatQuoteDate(quote.createdAt)} · vigente
            hasta {formatQuoteDate(quote.validUntil)}
          </p>
          {quote.source === "bot" && quote.status === "borrador" && (
            <p className="mt-2 rounded-md bg-warning-tint px-3 py-2 text-sm text-warning-text">
              Borrador creado por el bot: revisa servicios y cantidades antes de compartirlo.
            </p>
          )}
          {quote.duplicatedFrom && (
            <p className="mt-1 text-sm text-text-3">
              Corrige a{" "}
              <Link href={`/quotes/${quote.duplicatedFrom.id}`} className="underline">
                {quote.duplicatedFrom.folio}
              </Link>
            </p>
          )}
          {quote.duplicates.length > 0 && (
            <p className="mt-1 text-sm text-text-3">
              Corregida en{" "}
              {quote.duplicates.map((d, i) => (
                <span key={d.id}>
                  {i > 0 && ", "}
                  <Link href={`/quotes/${d.id}`} className="underline">
                    {d.folio}
                  </Link>
                </span>
              ))}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {can.manage && editable && !editing && editorOptions && (
            <Button variant="outline" onClick={() => setEditing(true)}>
              Editar
            </Button>
          )}
          {can.manage && can.publish && !editable && (
            <Button variant="outline" onClick={duplicate} disabled={busy !== null}>
              Duplicar
            </Button>
          )}
          {can.publish && (quote.status === "borrador" || quote.status === "enviada") && (
            <Button variant="destructive" onClick={cancel} disabled={busy !== null}>
              Cancelar cotización
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {editing && editorOptions ? (
        <section className="rounded-xl border p-4">
          <QuoteEditor
            mode="edit"
            quoteId={quote.id}
            options={editorOptions}
            initial={{
              items: quote.items.map((i) => ({ serviceId: i.serviceId, quantity: i.quantityMilli / 1000, description: i.description })),
              notes: quote.notes,
            }}
            tax={{ pricesIncludeTax: quote.pricesIncludeTax, taxRateBps: quote.taxRateBps }}
            onDone={() => setEditing(false)}
          />
        </section>
      ) : (
        <section className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-text-3">
                <th className="px-3 py-2 font-semibold">Descripción</th>
                <th className="px-3 py-2 text-right font-semibold">Cant.</th>
                <th className="px-3 py-2 text-right font-semibold">Precio unitario</th>
                <th className="px-3 py-2 text-right font-semibold">Importe</th>
              </tr>
            </thead>
            <tbody>
              {quote.items.map((item, i) => (
                <tr key={i} className="border-b align-top last:border-0">
                  <td className="whitespace-pre-line px-3 py-2">{item.description}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatQuantity(item.quantityMilli)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(item.unitPriceCents)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(item.lineTotalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="ml-auto w-full max-w-xs space-y-1 p-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-text-3">{quote.pricesIncludeTax ? "Subtotal (IVA incluido)" : "Subtotal"}</dt>
              <dd className="tabular-nums">{money(quote.subtotalCents)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-3">
                IVA {formatTaxRate(quote.taxRateBps)}
                {quote.pricesIncludeTax ? " incluido" : ""}
              </dt>
              <dd className="tabular-nums">{money(quote.taxCents)}</dd>
            </div>
            <div className="flex justify-between border-t pt-1 font-bold">
              <dt>Total</dt>
              <dd className="tabular-nums">{money(quote.totalCents)}</dd>
            </div>
          </dl>
          {quote.notes && <p className="border-t px-3 py-2 text-sm text-text-3">Notas internas: {quote.notes}</p>}
        </section>
      )}

      {can.publish && !quote.isTest && (quote.status === "borrador" || quote.latestSend?.status === "incierto") && (
        <WhatsAppSendPanel quoteId={quote.id} latest={quote.latestSend} />
      )}

      <section className="space-y-3 rounded-xl border p-4">
        <h3 className="font-semibold">Enlace para el cliente</h3>
        {issuedUrl ? (
          <div className="space-y-2 rounded-md bg-secondary p-3">
            <p className="text-sm font-semibold">Cópialo ahora: por seguridad no se volverá a mostrar.</p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                readOnly
                aria-label="Enlace de la cotización"
                value={issuedUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-xs"
              />
              <Button size="sm" onClick={copy}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copiado" : "Copiar"}
              </Button>
            </div>
            {quote.status === "borrador" && (
              <p className="text-xs text-text-3">
                Mientras sea borrador, el cliente verá una vista previa sin botones para responder.
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-text-3">
            {quote.link.active
              ? `Hay un enlace vigente (emitido el ${formatQuoteDate(quote.link.issuedAt!)}${
                  quote.link.lastViewedAt ? `, abierto por última vez el ${formatQuoteDate(quote.link.lastViewedAt)}` : ", aún sin abrir"
                }). El enlace en sí no se puede volver a mostrar; si lo perdiste, emite uno nuevo.`
              : "No hay un enlace vigente."}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {canIssueLink && (
            <Button variant={quote.link.active ? "outline" : "default"} onClick={issueLink} disabled={busy !== null}>
              {quote.link.active ? "Emitir un enlace nuevo" : "Emitir enlace"}
            </Button>
          )}
          {can.publish && quote.link.active && (
            <Button variant="outline" onClick={revoke} disabled={busy !== null}>
              Revocar enlace
            </Button>
          )}
          {can.publish && quote.status === "borrador" && (
            <Button onClick={markSent} disabled={busy !== null || !quote.link.active} title={quote.link.active ? undefined : "Primero emite un enlace"}>
              Marcar como enviada
            </Button>
          )}
        </div>
        {can.publish && quote.status === "borrador" && !quote.link.active && (
          <p className="text-xs text-text-3">Para marcarla como enviada primero emite un enlace y compártelo.</p>
        )}
        {!can.publish && (
          <p className="text-xs text-text-3">Compartir o cancelar cotizaciones lo hace el dueño o un administrador.</p>
        )}
      </section>

      <section className="space-y-1 rounded-xl border p-4 text-sm">
        <h3 className="mb-2 font-semibold">Seguimiento</h3>
        <p>
          <span className="text-text-3">Enviada:</span>{" "}
          {quote.sentAt
            ? `${formatQuoteDate(quote.sentAt)} · ${quote.sentVia === "whatsapp" ? "por WhatsApp" : "enlace compartido por el equipo"}${
                quote.sentByName ? ` · ${quote.sentByName}` : ""
              }`
            : "aún no"}
        </p>
        <p>
          <span className="text-text-3">Respuesta del cliente:</span>{" "}
          {quote.respondedAt
            ? `${quote.status === "aceptada" ? "Aceptó" : quote.status === "rechazada" ? "Rechazó" : "Respondió"} el ${formatQuoteDate(quote.respondedAt)}`
            : "sin respuesta"}
        </p>
        {quote.responseNote && (
          <blockquote className="mt-2 border-l-2 pl-3 text-text-2">“{quote.responseNote}”</blockquote>
        )}
      </section>
    </div>
  );
}
