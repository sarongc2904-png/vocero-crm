"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Settings = {
  pricesIncludeTax: boolean;
  taxRatePercent: number;
  defaultValidityDays: number;
  whatsappTemplateId: string | null;
};

type TemplateOption = { id: string; name: string; language: string; body: string; eligible: boolean; reason: string | null };

export function QuoteSettingsClient({
  initial,
  templates,
  canEdit,
}: {
  initial: Settings;
  templates: TemplateOption[];
  canEdit: boolean;
}) {
  const [pricesIncludeTax, setPricesIncludeTax] = useState(initial.pricesIncludeTax);
  const [taxRate, setTaxRate] = useState(String(initial.taxRatePercent));
  const [validity, setValidity] = useState(String(initial.defaultValidityDays));
  const [templateId, setTemplateId] = useState(initial.whatsappTemplateId ?? "");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const selected = templates.find((t) => t.id === templateId);

  async function save() {
    setStatus(null);
    setSaving(true);
    try {
      const res = await fetch("/api/quotes/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pricesIncludeTax,
          taxRatePercent: Number(taxRate),
          defaultValidityDays: Number(validity),
          whatsappTemplateId: templateId || null,
        }),
      });
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setStatus(res.ok ? { ok: true, text: "Guardado" } : { ok: false, text: data?.error?.message ?? "No se pudo guardar" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h3 className="text-base font-semibold">Cotizaciones</h3>
        <p className="text-sm text-text-3">
          Se aplica a las cotizaciones NUEVAS. Las ya creadas conservan el IVA y la vigencia con que nacieron.
        </p>
      </div>

      <fieldset disabled={!canEdit || saving} className="space-y-5">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={pricesIncludeTax}
            onChange={(e) => setPricesIncludeTax(e.target.checked)}
          />
          <span>
            <span className="font-semibold">Los precios del catálogo ya incluyen IVA</span>
            <span className="block text-text-3">
              Apagado (recomendado si dudas): el IVA se suma al precio. Encendido: el total es el precio y el IVA se desglosa.
            </span>
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="quote-tax">Tasa de IVA (%)</Label>
            <Input id="quote-tax" inputMode="decimal" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} />
            <p className="text-xs text-text-3">Entre 0 y 100, hasta 2 decimales.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="quote-validity">Vigencia por defecto (días)</Label>
            <Input
              id="quote-validity"
              inputMode="numeric"
              value={validity}
              onChange={(e) => setValidity(e.target.value.replace(/\D/g, ""))}
            />
            <p className="text-xs text-text-3">Entre 1 y 365.</p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="quote-template">Plantilla para enviar fuera de la ventana de 24 h</Label>
          <select
            id="quote-template"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            className="h-9 w-full rounded-md border border-border-strong bg-background px-3 text-sm"
          >
            <option value="">Ninguna (solo se envía dentro de la ventana de 24 h)</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id} disabled={!t.eligible}>
                {t.name} ({t.language}){t.eligible ? "" : ` — ${t.reason}`}
              </option>
            ))}
          </select>
          <p className="text-xs text-text-3">
            Debe estar aprobada y tener exactamente tres variables: {"{{1}}"} nombre del cliente, {"{{2}}"} folio y{" "}
            {"{{3}}"} enlace de la cotización.
          </p>
          {selected && <p className="rounded-md bg-secondary p-2 text-xs">{selected.body}</p>}
          <p role="note" className="rounded-md bg-warning-tint p-3 text-sm text-warning-text">
            Meta puede cobrar por cada plantilla enviada fuera de la ventana de 24 h, según su categoría y el país del
            cliente. Dentro de la ventana, la cotización se manda como PDF sin plantilla.
          </p>
        </div>
      </fieldset>

      {canEdit ? (
        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={saving}>
            {saving ? "Guardando…" : "Guardar"}
          </Button>
          {status && (
            <span role="status" className={`text-sm ${status.ok ? "text-success-text" : "text-destructive"}`}>
              {status.text}
            </span>
          )}
        </div>
      ) : (
        <p className="text-sm text-text-3">Solo el dueño o un administrador pueden cambiar esta configuración.</p>
      )}
    </div>
  );
}
