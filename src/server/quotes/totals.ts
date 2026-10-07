/**
 * Totales de una cotización. Todo en CENTAVOS ENTEROS, también el cálculo
 * intermedio (BigInt): sumar pesos en coma flotante da totales que el dueño
 * no puede cuadrar, y cantidad × precio puede pasar de 2^53.
 *
 * Reglas (fijas, para que la cotización, el PDF y la página pública digan lo
 * mismo):
 *  1. Cada línea se redondea por separado: round(cantidad × precio unitario).
 *  2. El subtotal es la suma exacta de las líneas ya redondeadas.
 *  3. El IVA se calcula UNA vez, sobre el subtotal, y se redondea una vez.
 *     - Precios sin IVA: IVA = round(subtotal × tasa); total = subtotal + IVA.
 *     - Precios con IVA: el subtotal ya lo trae; se desglosa
 *       IVA = subtotal − round(subtotal / (1 + tasa)); total = subtotal.
 *  4. Redondeo "half up" (0.5 sube). Los montos nunca son negativos.
 *
 * El servidor SIEMPRE llama esto con precios de la base; ningún monto que
 * mande un cliente entra aquí.
 */

/** 1 unidad = 1000 milésimas. */
export const QUANTITY_SCALE = 1000;
/** 100 % = 10000 puntos base. */
export const BPS_SCALE = 10_000;
/** Tope de cantidad por línea: cabe holgado en integer (milésimas). */
export const MAX_QUANTITY_MILLI = 1_000_000 * QUANTITY_SCALE;
/** Tope de un monto en centavos: cabe exacto en un número de JS. */
export const MAX_CENTS = Number.MAX_SAFE_INTEGER;

export class QuoteAmountError extends Error {
  readonly code = "invalid_amount" as const;
  constructor(message: string) {
    super(message);
    this.name = "QuoteAmountError";
  }
}

/** División entera con redondeo half-up para numerador y divisor no negativos. */
function divRoundHalfUp(numerator: bigint, divisor: bigint): bigint {
  return (numerator * 2n + divisor) / (divisor * 2n);
}

function toSafeNumber(value: bigint, label: string): number {
  if (value > BigInt(MAX_CENTS)) {
    throw new QuoteAmountError(`${label} excede el máximo permitido`);
  }
  return Number(value);
}

function assertNonNegativeInt(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new QuoteAmountError(`${label} debe ser un entero no negativo`);
  }
}

/**
 * Convierte una cantidad decimal (1, 1.5, 0.25) a milésimas, sin aceptar más
 * de tres decimales: "1.0004" se rechaza en vez de redondearse en silencio.
 */
export function quantityToMilli(quantity: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new QuoteAmountError("La cantidad debe ser mayor que cero");
  }
  const milli = Math.round(quantity * QUANTITY_SCALE);
  if (Math.abs(quantity * QUANTITY_SCALE - milli) > 1e-6) {
    throw new QuoteAmountError("La cantidad admite como máximo 3 decimales");
  }
  if (milli <= 0 || milli > MAX_QUANTITY_MILLI) {
    throw new QuoteAmountError("La cantidad está fuera de rango");
  }
  return milli;
}

/** round(cantidad × precio unitario), en centavos. */
export function lineTotalCents(quantityMilli: number, unitPriceCents: number): number {
  assertNonNegativeInt(quantityMilli, "La cantidad");
  if (quantityMilli === 0 || quantityMilli > MAX_QUANTITY_MILLI) {
    throw new QuoteAmountError("La cantidad está fuera de rango");
  }
  assertNonNegativeInt(unitPriceCents, "El precio unitario");
  const raw = BigInt(quantityMilli) * BigInt(unitPriceCents);
  return toSafeNumber(divRoundHalfUp(raw, BigInt(QUANTITY_SCALE)), "El importe de la línea");
}

export type QuoteTotals = {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
};

export function computeQuoteTotals(input: {
  lineTotalsCents: readonly number[];
  pricesIncludeTax: boolean;
  taxRateBps: number;
}): QuoteTotals {
  const { taxRateBps } = input;
  if (!Number.isInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > BPS_SCALE) {
    throw new QuoteAmountError("La tasa de IVA debe estar entre 0 y 100 %");
  }

  let subtotal = 0n;
  for (const line of input.lineTotalsCents) {
    assertNonNegativeInt(line, "El importe de la línea");
    subtotal += BigInt(line);
  }

  const bps = BigInt(taxRateBps);
  const scale = BigInt(BPS_SCALE);
  let tax: bigint;
  let total: bigint;
  if (input.pricesIncludeTax) {
    const base = divRoundHalfUp(subtotal * scale, scale + bps);
    tax = subtotal - base;
    total = subtotal;
  } else {
    tax = divRoundHalfUp(subtotal * bps, scale);
    total = subtotal + tax;
  }

  return {
    subtotalCents: toSafeNumber(subtotal, "El subtotal"),
    taxCents: toSafeNumber(tax, "El IVA"),
    totalCents: toSafeNumber(total, "El total"),
  };
}
