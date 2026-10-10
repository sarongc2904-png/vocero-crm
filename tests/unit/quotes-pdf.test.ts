import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { extractText } from "unpdf";
import { renderQuotePdf, toWinAnsi, wrapText, type QuotePdfInput } from "@/server/quotes/pdf";

function base(overrides: Partial<QuotePdfInput> = {}): QuotePdfInput {
  return {
    business: { name: "Construcciones Peña y Ñúñez" },
    folio: "COT-0007",
    issuedAt: new Date("2026-10-07T18:00:00Z"),
    validUntil: new Date("2026-10-22T18:00:00Z"),
    currency: "MXN",
    pricesIncludeTax: false,
    taxRateBps: 1600,
    subtotalCents: 314993,
    taxCents: 50399,
    totalCents: 365392,
    items: [
      { description: "Instalación de baño", quantityMilli: 2000, unitPriceCents: 150000, lineTotalCents: 300000 },
      { description: "Material eléctrico", quantityMilli: 1500, unitPriceCents: 9995, lineTotalCents: 14993 },
    ],
    ...overrides,
  };
}

async function textOf(bytes: Uint8Array): Promise<{ pages: string[]; all: string }> {
  const { text } = await extractText(new Uint8Array(bytes), { mergePages: false });
  const pages = text as string[];
  return { pages, all: pages.join("\n") };
}

async function helvetica() {
  const doc = await PDFDocument.create();
  return doc.embedFont(StandardFonts.Helvetica);
}

describe("toWinAnsi", () => {
  it("conserva el español completo", async () => {
    const font = await helvetica();
    const s = "Cotización ÁÉÍÓÚ áéíóú Ññ ü ¿Sí? ¡Ya! € “comillas” — guion";
    expect(toWinAnsi(font, s)).toBe(s);
  });

  it("degrada lo que las fuentes estándar no pueden dibujar, sin lanzar", async () => {
    const font = await helvetica();
    expect(toWinAnsi(font, "Pintura 😀 ✓ → ok")).toBe("Pintura ? ? ? ok");
    expect(toWinAnsi(font, "Łódź Ōsaka")).toBe("?ódz Osaka");
    expect(toWinAnsi(font, "a\tb\r\nc")).toBe("a b\nc");
  });
});

describe("wrapText", () => {
  it("respeta saltos de línea y nunca excede el ancho", async () => {
    const font = await helvetica();
    const lines = wrapText(font, "Primera línea\nSegunda línea con bastantes palabras para partirse en varios renglones", 10, 120);
    expect(lines[0]).toBe("Primera línea");
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) expect(font.widthOfTextAtSize(line, 10)).toBeLessThanOrEqual(120);
  });

  it("parte a la fuerza una palabra que no cabe sola", async () => {
    const font = await helvetica();
    const lines = wrapText(font, "X".repeat(200), 10, 100);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe("X".repeat(200));
    for (const line of lines) expect(font.widthOfTextAtSize(line, 10)).toBeLessThanOrEqual(100);
  });
});

describe("renderQuotePdf", () => {
  it("genera un PDF válido con acentos, ñ, folio, montos y vigencia", async () => {
    const bytes = await renderQuotePdf(base());
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    const { all } = await textOf(bytes);
    for (const expected of [
      "Construcciones Peña y Ñúñez",
      "Cotización COT-0007",
      "Instalación de baño",
      "Material eléctrico",
      "1.5",
      "$1,500.00",
      "$3,000.00",
      "$149.93",
      "Subtotal",
      "$3,149.93",
      "IVA 16 %",
      "$503.99",
      "Total",
      "$3,653.92",
      "Vigente hasta: 22 de octubre de 2026",
    ]) {
      expect(all, expected).toContain(expected);
    }
  });

  it("con IVA incluido lo dice y no lo suma", async () => {
    const bytes = await renderQuotePdf(
      base({ pricesIncludeTax: true, subtotalCents: 150000, taxCents: 20690, totalCents: 150000, items: [
        { description: "Instalación", quantityMilli: 1000, unitPriceCents: 150000, lineTotalCents: 150000 },
      ] })
    );
    const { all } = await textOf(bytes);
    expect(all).toContain("Subtotal (IVA incluido)");
    expect(all).toContain("IVA 16 % incluido");
    expect(all).toContain("$206.90");
  });

  it("descripciones largas con saltos de línea no rompen el PDF ni se pierden", async () => {
    const long =
      "Remodelación integral de cocina:\n- Demolición de azulejo existente\n- Instalación eléctrica nueva con contactos dobles\n" +
      "Incluye mano de obra, limpieza y retiro de escombro. ".repeat(6);
    const bytes = await renderQuotePdf(
      base({ items: [{ description: long, quantityMilli: 1000, unitPriceCents: 100, lineTotalCents: 100 }] })
    );
    const { all } = await textOf(bytes);
    expect(all).toContain("Remodelación integral de cocina:");
    expect(all).toContain("- Demolición de azulejo existente");
    expect(all).toContain("retiro de escombro");
  });

  it("una cotización larga ocupa varias páginas, numeradas, con el total en la última", async () => {
    const items = Array.from({ length: 80 }, (_, i) => ({
      description: `Partida ${i + 1}: suministro e instalación de pieza número ${i + 1}`,
      quantityMilli: 1000,
      unitPriceCents: 1000,
      lineTotalCents: 1000,
    }));
    const bytes = await renderQuotePdf(base({ items, subtotalCents: 80000, taxCents: 12800, totalCents: 92800 }));
    const doc = await PDFDocument.load(bytes);
    const pageCount = doc.getPageCount();
    expect(pageCount).toBeGreaterThanOrEqual(3);

    const { pages } = await textOf(bytes);
    pages.forEach((page, i) => expect(page).toContain(`COT-0007 · Página ${i + 1} de ${pageCount}`));
    for (const page of pages.slice(1)) {
      expect(page).toContain("(continuación)");
      expect(page).toContain("Descripción"); // encabezado de tabla repetido
    }
    for (let i = 1; i <= 80; i += 1) expect(pages.join("\n")).toContain(`Partida ${i}:`);
    expect(pages.at(-1)).toContain("$928.00");
    expect(pages.slice(0, -1).join("\n")).not.toContain("$928.00");
  });

  it("caracteres fuera de WinAnsi en nombre o líneas no tumban el PDF", async () => {
    const bytes = await renderQuotePdf(
      base({
        business: { name: "Taller 🔧 Łukasz" },
        items: [{ description: "Pintura ✓ → acabado ✨", quantityMilli: 1000, unitPriceCents: 100, lineTotalCents: 100 }],
      })
    );
    const { all } = await textOf(bytes);
    expect(all).toContain("Taller ? ?ukasz");
    expect(all).toContain("Pintura ? ? acabado ?");
  });

  it("no contiene ids internos", async () => {
    const { all } = await textOf(await renderQuotePdf(base()));
    expect(all).not.toMatch(/\b(?:qt|qti|qtl|org|ct|cv|svc)_[a-z0-9]{6,}/);
  });

  it("un logo inválido se omite sin fallar", async () => {
    const bytes = await renderQuotePdf(
      base({ business: { name: "Negocio", logo: { bytes: new Uint8Array([1, 2, 3]), mime: "image/png" } } })
    );
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
  });
});
