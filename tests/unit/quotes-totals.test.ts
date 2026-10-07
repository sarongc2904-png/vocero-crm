import { describe, expect, it } from "vitest";
import {
  computeQuoteTotals,
  lineTotalCents,
  quantityToMilli,
  QuoteAmountError,
} from "@/server/quotes/totals";

describe("quantityToMilli", () => {
  it("convierte cantidades con hasta 3 decimales sin coma flotante", () => {
    expect(quantityToMilli(1)).toBe(1000);
    expect(quantityToMilli(1.5)).toBe(1500);
    expect(quantityToMilli(0.001)).toBe(1);
    expect(quantityToMilli(2.675)).toBe(2675);
    expect(quantityToMilli(0.1 + 0.2)).toBe(300); // 0.30000000000000004
  });

  it("rechaza más de 3 decimales, cero, negativos y no finitos", () => {
    for (const bad of [1.0004, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.0004]) {
      expect(() => quantityToMilli(bad)).toThrow(QuoteAmountError);
    }
  });

  it("rechaza cantidades fuera de rango", () => {
    expect(() => quantityToMilli(1_000_001)).toThrow(QuoteAmountError);
  });
});

describe("lineTotalCents: redondeo por línea, half-up", () => {
  it("multiplica sin decimales", () => {
    expect(lineTotalCents(1000, 150000)).toBe(150000);
    expect(lineTotalCents(3000, 999)).toBe(2997);
  });

  it("redondea cada línea a centavo, 0.5 sube", () => {
    expect(lineTotalCents(1500, 333)).toBe(500); // 499.5 → 500
    expect(lineTotalCents(1, 499)).toBe(0); // 0.499 → 0
    expect(lineTotalCents(1, 500)).toBe(1); // 0.5 → 1
    expect(lineTotalCents(333, 100)).toBe(33); // 33.3 → 33
  });

  it("no pierde precisión cuando el intermedio excede 2^53", () => {
    // 1,000,000 unidades × $90,000.00 = 9e18 milésimas·centavo en el intermedio.
    expect(lineTotalCents(1_000_000_000, 9_000_000)).toBe(9_000_000_000_000);
    // 1.001 × $90,071,992,547.41 (intermedio > 2^53) redondea exacto.
    expect(lineTotalCents(1001, 9_007_199_254_741)).toBe(9_016_206_453_996);
  });

  it("rechaza un importe que ya no cabe exacto en un número", () => {
    expect(() => lineTotalCents(1_000_000_000, 9_000_000_000_000)).toThrow(QuoteAmountError);
  });

  it("rechaza precios negativos o no enteros", () => {
    expect(() => lineTotalCents(1000, -1)).toThrow(QuoteAmountError);
    expect(() => lineTotalCents(1000, 1.5)).toThrow(QuoteAmountError);
    expect(() => lineTotalCents(0, 100)).toThrow(QuoteAmountError);
  });
});

describe("computeQuoteTotals: IVA una sola vez sobre el subtotal", () => {
  it("precios SIN IVA: suma el 16 % encima", () => {
    expect(
      computeQuoteTotals({ lineTotalsCents: [100000, 50000], pricesIncludeTax: false, taxRateBps: 1600 })
    ).toEqual({ subtotalCents: 150000, taxCents: 24000, totalCents: 174000 });
  });

  it("precios CON IVA: el total es el subtotal y el IVA se desglosa", () => {
    expect(
      computeQuoteTotals({ lineTotalsCents: [116000], pricesIncludeTax: true, taxRateBps: 1600 })
    ).toEqual({ subtotalCents: 116000, taxCents: 16000, totalCents: 116000 });
  });

  it("el IVA se calcula sobre el subtotal, no línea por línea", () => {
    // Tres líneas de 0.33: IVA por línea daría 3 × round(5.28) = 15;
    // sobre el subtotal es round(99 × 0.16) = round(15.84) = 16.
    const totals = computeQuoteTotals({ lineTotalsCents: [33, 33, 33], pricesIncludeTax: false, taxRateBps: 1600 });
    expect(totals).toEqual({ subtotalCents: 99, taxCents: 16, totalCents: 115 });
  });

  it("redondea el IVA half-up", () => {
    // 5 centavos × 10 % = 0.5 → 1; 4 × 10 % = 0.4 → 0.
    expect(computeQuoteTotals({ lineTotalsCents: [5], pricesIncludeTax: false, taxRateBps: 1000 }).taxCents).toBe(1);
    expect(computeQuoteTotals({ lineTotalsCents: [4], pricesIncludeTax: false, taxRateBps: 1000 }).taxCents).toBe(0);
  });

  it("cumple siempre la invariante que también exige la base (quote_total_ck)", () => {
    for (let subtotal = 0; subtotal < 5000; subtotal += 7) {
      for (const pricesIncludeTax of [true, false]) {
        const t = computeQuoteTotals({ lineTotalsCents: [subtotal], pricesIncludeTax, taxRateBps: 1600 });
        expect(t.totalCents).toBe(pricesIncludeTax ? t.subtotalCents : t.subtotalCents + t.taxCents);
        expect(t.taxCents).toBeGreaterThanOrEqual(0);
        if (pricesIncludeTax) expect(t.taxCents).toBeLessThanOrEqual(t.subtotalCents);
      }
    }
  });

  it("tasa 0 % no agrega nada; cotización sin líneas da ceros", () => {
    expect(computeQuoteTotals({ lineTotalsCents: [1234], pricesIncludeTax: false, taxRateBps: 0 })).toEqual({
      subtotalCents: 1234,
      taxCents: 0,
      totalCents: 1234,
    });
    expect(computeQuoteTotals({ lineTotalsCents: [], pricesIncludeTax: true, taxRateBps: 1600 })).toEqual({
      subtotalCents: 0,
      taxCents: 0,
      totalCents: 0,
    });
  });

  it("rechaza tasas fuera de 0–100 % y líneas negativas", () => {
    expect(() => computeQuoteTotals({ lineTotalsCents: [1], pricesIncludeTax: false, taxRateBps: -1 })).toThrow(QuoteAmountError);
    expect(() => computeQuoteTotals({ lineTotalsCents: [1], pricesIncludeTax: false, taxRateBps: 10001 })).toThrow(QuoteAmountError);
    expect(() => computeQuoteTotals({ lineTotalsCents: [-5], pricesIncludeTax: false, taxRateBps: 1600 })).toThrow(QuoteAmountError);
  });
});
