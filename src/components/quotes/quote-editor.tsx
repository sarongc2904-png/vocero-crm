"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatMoneyCents } from "@/lib/money";
import { formatTaxRate } from "@/lib/quote-format";
// Funciones PURAS (sin base ni Node): la vista previa usa exactamente la misma
// aritmética que el servidor, que de todos modos recalcula al guardar.
import { computeQuoteTotals, lineTotalCents, quantityToMilli } from "@/server/quotes/totals";

export type EditorOptions = {
  conversations: { id: string; contactName: string }[];
  services: { id: string; name: string; priceCents: number; currency: string }[];
  settings: { pricesIncludeTax: boolean; taxRateBps: number; defaultValidityDays: number };
};

type Line = { key: number; serviceId: string; quantity: string };

type Props =
  | { mode: "create"; options: EditorOptions; initialConversationId?: string }
  | {
      mode: "edit";
      options: EditorOptions;
      quoteId: string;
      initial: { items: { serviceId: string | null; quantity: number; description: string }[]; notes: string | null };
      /** IVA con el que nació el borrador (no cambia al editar). */
      tax: { pricesIncludeTax: boolean; taxRateBps: number };
      onDone?: () => void;
    };

let keySeq = 0;
const nextKey = () => (keySeq += 1);

export function QuoteEditor(props: Props) {
  const router = useRouter();
  const { options } = props;
  const servicesById = useMemo(() => new Map(options.services.map((s) => [s.id, s])), [options.services]);

  // Líneas de un borrador cuyo servicio ya no está activo no se pueden volver
  // a cotizar con precio de catálogo: se avisan y se quitan.
  const dropped =
    props.mode === "edit"
      ? props.initial.items.filter((item) => !item.serviceId || !servicesById.has(item.serviceId))
      : [];
  const [conversationId, setConversationId] = useState(
    props.mode === "create" ? props.initialConversationId ?? "" : ""
  );
  const [lines, setLines] = useState<Line[]>(() =>
    props.mode === "edit"
      ? props.initial.items
          .filter((item) => item.serviceId && servicesById.has(item.serviceId))
          .map((item) => ({ key: nextKey(), serviceId: item.serviceId!, quantity: String(item.quantity) }))
      : [{ key: nextKey(), serviceId: "", quantity: "1" }]
  );
  const [notes, setNotes] = useState(props.mode === "edit" ? props.initial.notes ?? "" : "");
  const [validityDays, setValidityDays] = useState(
    props.mode === "create" ? String(options.settings.defaultValidityDays) : ""
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tax = props.mode === "edit" ? props.tax : options.settings;

  const preview = useMemo(() => {
    try {
      const priced = lines
        .filter((l) => l.serviceId)
        .map((l) => {
          const service = servicesById.get(l.serviceId)!;
          return { service, total: lineTotalCents(quantityToMilli(Number(l.quantity)), service.priceCents) };
        });
      if (priced.length === 0) return null;
      const currencies = new Set(priced.map((p) => p.service.currency));
      if (currencies.size > 1) return { error: "Todas las líneas deben estar en la misma moneda" };
      return {
        currency: priced[0]!.service.currency,
        lineTotals: priced.map((p) => p.total),
        ...computeQuoteTotals({
          lineTotalsCents: priced.map((p) => p.total),
          pricesIncludeTax: tax.pricesIncludeTax,
          taxRateBps: tax.taxRateBps,
        }),
      };
    } catch {
      return { error: "Revisa las cantidades (mayores que cero, hasta 3 decimales)" };
    }
  }, [lines, servicesById, tax.pricesIncludeTax, tax.taxRateBps]);

  const money = (cents: number, currency: string) => formatMoneyCents(cents, currency) ?? String(cents / 100);

  async function save() {
    setError(null);
    if (props.mode === "create" && !conversationId) return setError("Elige la conversación del cliente");
    const items = lines.filter((l) => l.serviceId).map((l) => ({ serviceId: l.serviceId, quantity: Number(l.quantity) }));
    if (items.length === 0) return setError("Agrega al menos un servicio");
    if (preview && "error" in preview) return setError(preview.error ?? "Revisa las líneas");

    const body: Record<string, unknown> = { items, notes: notes.trim() || null };
    if (validityDays) body.validityDays = Number(validityDays);
    if (props.mode === "create") body.conversationId = conversationId;

    setSaving(true);
    try {
      const res = await fetch(props.mode === "create" ? "/api/quotes" : `/api/quotes/${props.quoteId}`, {
        method: props.mode === "create" ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as { quote?: { id: string }; error?: { message: string } } | null;
      if (!res.ok) {
        setError(data?.error?.message ?? "No se pudo guardar la cotización");
        return;
      }
      if (props.mode === "create") {
        router.push(`/quotes/${data!.quote!.id}`);
      } else {
        props.onDone?.();
        router.refresh();
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      {props.mode === "create" && (
        <div className="space-y-1.5">
          <Label htmlFor="quote-conversation">Cliente (conversación)</Label>
          <select
            id="quote-conversation"
            value={conversationId}
            onChange={(e) => setConversationId(e.target.value)}
            className="h-9 w-full rounded-md border border-border-strong bg-background px-3 text-sm"
          >
            <option value="">Elige una conversación…</option>
            {options.conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.contactName}
              </option>
            ))}
          </select>
        </div>
      )}

      {dropped.length > 0 && (
        <p role="alert" className="rounded-md bg-warning-tint p-3 text-sm text-warning-text">
          {dropped.length === 1 ? "Una línea ya no está" : `${dropped.length} líneas ya no están`} en el catálogo
          activo ({dropped.map((d) => d.description).join(", ")}). Al guardar se quitarán.
        </p>
      )}

      <div className="space-y-2">
        <Label>Servicios</Label>
        {options.services.length === 0 && (
          <p className="text-sm text-text-3">No hay servicios activos en el catálogo. Agrégalos en Ajustes.</p>
        )}
        {lines.map((line, i) => {
          const service = servicesById.get(line.serviceId);
          const total = preview && !("error" in preview) && line.serviceId ? preview.lineTotals[lines.filter((l) => l.serviceId).indexOf(line)] : null;
          return (
            <div key={line.key} className="flex flex-wrap items-center gap-2">
              <select
                aria-label={`Servicio de la línea ${i + 1}`}
                value={line.serviceId}
                onChange={(e) =>
                  setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, serviceId: e.target.value } : l)))
                }
                className="h-9 min-w-0 flex-1 basis-56 rounded-md border border-border-strong bg-background px-3 text-sm"
              >
                <option value="">Elige un servicio…</option>
                {options.services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} — {money(s.priceCents, s.currency)}
                  </option>
                ))}
              </select>
              <Input
                aria-label={`Cantidad de la línea ${i + 1}`}
                inputMode="decimal"
                value={line.quantity}
                onChange={(e) =>
                  setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, quantity: e.target.value } : l)))
                }
                className="w-24"
              />
              <span className="w-28 text-right text-sm tabular-nums">
                {service && typeof total === "number" ? money(total, service.currency) : "—"}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Quitar la línea ${i + 1}`}
                onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                disabled={lines.length === 1}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          );
        })}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setLines((prev) => [...prev, { key: nextKey(), serviceId: "", quantity: "1" }])}
          disabled={lines.length >= 50}
        >
          <Plus className="h-4 w-4" /> Agregar servicio
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="quote-validity">
            {props.mode === "create" ? "Vigencia (días)" : "Nueva vigencia en días (vacío = no cambiar)"}
          </Label>
          <Input
            id="quote-validity"
            inputMode="numeric"
            value={validityDays}
            onChange={(e) => setValidityDays(e.target.value.replace(/\D/g, ""))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="quote-notes">Notas internas</Label>
          <Textarea
            id="quote-notes"
            rows={2}
            maxLength={2000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="No se muestran al cliente"
          />
        </div>
      </div>

      {preview && !("error" in preview) && (
        <dl className="ml-auto w-full max-w-xs space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-text-3">{tax.pricesIncludeTax ? "Subtotal (IVA incluido)" : "Subtotal"}</dt>
            <dd className="tabular-nums">{money(preview.subtotalCents, preview.currency)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-3">
              IVA {formatTaxRate(tax.taxRateBps)}
              {tax.pricesIncludeTax ? " incluido" : ""}
            </dt>
            <dd className="tabular-nums">{money(preview.taxCents, preview.currency)}</dd>
          </div>
          <div className="flex justify-between border-t pt-1 font-bold">
            <dt>Total</dt>
            <dd className="tabular-nums">{money(preview.totalCents, preview.currency)}</dd>
          </div>
          <p className="text-xs text-text-3">Precios del catálogo; el servidor recalcula al guardar.</p>
        </dl>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button onClick={save} disabled={saving}>
          {saving ? "Guardando…" : props.mode === "create" ? "Crear borrador" : "Guardar cambios"}
        </Button>
        {props.mode === "edit" && props.onDone && (
          <Button variant="outline" onClick={props.onDone} disabled={saving}>
            Cancelar edición
          </Button>
        )}
      </div>
    </div>
  );
}
