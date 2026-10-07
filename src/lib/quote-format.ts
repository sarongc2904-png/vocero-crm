/**
 * Formato de cotizaciones compartido por el servidor (PDF, página pública) y
 * el navegador (pantallas del CRM). Vive en `lib/` y no importa nada de
 * servidor: lo usan componentes de cliente.
 */

export type QuoteStatusValue = "borrador" | "enviada" | "aceptada" | "rechazada" | "expirada" | "cancelada";

/** 1 unidad = 1000 milésimas (igual que `QUANTITY_SCALE` en totals.ts). */
export function formatQuantity(quantityMilli: number): string {
  return new Intl.NumberFormat("es-MX", { maximumFractionDigits: 3 }).format(quantityMilli / 1000);
}

export function formatTaxRate(taxRateBps: number): string {
  return `${new Intl.NumberFormat("es-MX", { maximumFractionDigits: 2 }).format(taxRateBps / 100)} %`;
}

/** Etiquetas para el OPERADOR del CRM. */
export const QUOTE_STATUS_LABEL: Record<QuoteStatusValue, string> = {
  borrador: "Borrador",
  enviada: "Enviada",
  aceptada: "Aceptada",
  rechazada: "Rechazada",
  expirada: "Vencida",
  cancelada: "Cancelada",
};

export function formatQuoteDate(value: Date | string, timeZone = "America/Mexico_City"): string {
  return new Intl.DateTimeFormat("es-MX", { timeZone, day: "numeric", month: "short", year: "numeric" }).format(
    typeof value === "string" ? new Date(value) : value
  );
}
