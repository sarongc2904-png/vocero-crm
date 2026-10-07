import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { formatMoneyCents } from "@/lib/money";
import { QUANTITY_SCALE } from "@/server/quotes/totals";

/**
 * PDF de una cotización con pdf-lib y las fuentes ESTÁNDAR (Helvetica): sin
 * archivos de fuente que empaquetar ni registrar.
 *
 * Las fuentes estándar solo codifican WinAnsi (Latin-1 extendido). Español
 * completo cabe (á é í ó ú ü ñ ¿ ¡ € “ ”); lo que no cabe (emojis, flechas,
 * letras de otros alfabetos, tabuladores) HARÍA FALLAR el PDF entero, así que
 * todo texto pasa por `toWinAnsi()` antes de dibujarse.
 *
 * El documento lleva exactamente lo mismo que la página pública: nombre y
 * logo del negocio, folio, líneas, totales y vigencia. Ningún id interno ni
 * dato del cliente.
 */

export type QuotePdfInput = {
  business: { name: string; logo?: { bytes: Uint8Array; mime: string } | null };
  folio: string;
  issuedAt: Date;
  validUntil: Date;
  currency: string;
  pricesIncludeTax: boolean;
  taxRateBps: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  items: { description: string; quantityMilli: number; unitPriceCents: number; lineTotalCents: number }[];
  timeZone?: string;
  /** Vista previa de un borrador: marca de agua "BORRADOR" en cada página. */
  draft?: boolean;
};

const PAGE_W = 612; // Carta
const PAGE_H = 792;
const MARGIN = 50;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM = 70; // deja aire para el pie de página
const BODY = 10;
const LINE = 13;

const COLS = {
  description: { x: MARGIN, w: 262 },
  quantity: { x: MARGIN + 270, w: 60 },
  unit: { x: MARGIN + 338, w: 84 },
  total: { x: MARGIN + 430, w: CONTENT_W - 430 },
};

const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);
const RULE = rgb(0.85, 0.85, 0.88);
const DRAFT_RED = rgb(0.75, 0.1, 0.1);

/**
 * Deja solo lo que Helvetica estándar puede dibujar. Letras con diacríticos
 * fuera de WinAnsi (ő, Ā) pierden el acento; lo demás que no cabe se vuelve
 * "?" para que se note que había algo. Saltos de línea se conservan: los
 * maneja `wrapText`.
 */
export function toWinAnsi(font: PDFFont, text: string): string {
  let out = "";
  for (const char of text.replace(/\r\n?/g, "\n").replace(/\t/g, " ")) {
    if (char === "\n") {
      out += char;
      continue;
    }
    if (canEncode(font, char)) {
      out += char;
      continue;
    }
    const base = char.normalize("NFKD").replace(/\p{M}/gu, "");
    out += base && [...base].every((c) => canEncode(font, c)) ? base : "?";
  }
  return out;
}

function canEncode(font: PDFFont, char: string): boolean {
  if (char < " ") return false;
  try {
    font.encodeText(char);
    return true;
  } catch {
    return false;
  }
}

/**
 * Corta el texto a lo ancho de la columna: respeta los saltos de línea del
 * original, parte por palabras y, si una palabra sola no cabe, la parte a
 * la fuerza para que nunca se salga de la página.
 */
export function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const width = (s: string) => font.widthOfTextAtSize(s, size);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/ +/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (width(candidate) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      current = "";
      let rest = word;
      while (width(rest) > maxWidth) {
        let cut = rest.length - 1;
        while (cut > 1 && width(rest.slice(0, cut)) > maxWidth) cut -= 1;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      current = rest;
    }
    lines.push(current);
  }
  return lines;
}

export function formatQuantity(quantityMilli: number): string {
  return new Intl.NumberFormat("es-MX", { maximumFractionDigits: 3 }).format(quantityMilli / QUANTITY_SCALE);
}

export function formatTaxRate(taxRateBps: number): string {
  return `${new Intl.NumberFormat("es-MX", { maximumFractionDigits: 2 }).format(taxRateBps / 100)} %`;
}

function money(cents: number, currency: string): string {
  return formatMoneyCents(cents, currency) ?? `${(cents / 100).toFixed(2)} ${currency}`;
}

function formatDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("es-MX", { timeZone, day: "numeric", month: "long", year: "numeric" }).format(date);
}

export async function renderQuotePdf(input: QuotePdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const timeZone = input.timeZone ?? "America/Mexico_City";
  const t = (s: string) => toWinAnsi(font, s);

  doc.setTitle(t(`Cotización ${input.folio}`));
  doc.setAuthor(t(input.business.name));
  doc.setCreator("Conecta Digital CRM");
  doc.setProducer("pdf-lib");

  let logo: PDFImage | null = null;
  if (input.business.logo) {
    try {
      if (input.business.logo.mime === "image/png") logo = await doc.embedPng(input.business.logo.bytes);
      else if (input.business.logo.mime === "image/jpeg") logo = await doc.embedJpg(input.business.logo.bytes);
    } catch {
      logo = null; // Un logo dañado no tumba la cotización.
    }
  }

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;

  const text = (s: string, x: number, yy: number, opts: { size?: number; f?: PDFFont; color?: typeof INK } = {}) =>
    page.drawText(s, { x, y: yy, size: opts.size ?? BODY, font: opts.f ?? font, color: opts.color ?? INK });
  const right = (s: string, col: { x: number; w: number }, yy: number, f: PDFFont = font, size = BODY) =>
    text(s, col.x + col.w - f.widthOfTextAtSize(s, size), yy, { f, size });
  const rule = (yy: number) =>
    page.drawLine({ start: { x: MARGIN, y: yy }, end: { x: PAGE_W - MARGIN, y: yy }, thickness: 0.6, color: RULE });

  const tableHeader = () => {
    text("Descripción", COLS.description.x, y, { f: bold, size: 9, color: MUTED });
    right("Cant.", COLS.quantity, y, bold, 9);
    right("Precio unitario", COLS.unit, y, bold, 9);
    right("Importe", COLS.total, y, bold, 9);
    y -= 8;
    rule(y);
    y -= LINE + 2;
  };

  const newPage = (first: boolean) => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    y = PAGE_H - MARGIN;
    if (first) {
      let nameX = MARGIN;
      if (logo) {
        const scaled = logo.scaleToFit(56, 56);
        page.drawImage(logo, { x: MARGIN, y: y - scaled.height + 4, width: scaled.width, height: scaled.height });
        nameX = MARGIN + scaled.width + 12;
      }
      for (const [i, line] of wrapText(bold, t(input.business.name), 16, PAGE_W - MARGIN - nameX - 170).slice(0, 2).entries()) {
        text(line, nameX, y - 12 - i * 19, { f: bold, size: 16 });
      }
      const label = t(`Cotización ${input.folio}`);
      text(label, PAGE_W - MARGIN - bold.widthOfTextAtSize(label, 13), y - 12, { f: bold, size: 13 });
      const issued = t(`Fecha: ${formatDate(input.issuedAt, timeZone)}`);
      text(issued, PAGE_W - MARGIN - font.widthOfTextAtSize(issued, 9), y - 28, { size: 9, color: MUTED });
      const valid = t(`Vigente hasta: ${formatDate(input.validUntil, timeZone)}`);
      text(valid, PAGE_W - MARGIN - font.widthOfTextAtSize(valid, 9), y - 41, { size: 9, color: MUTED });
      y -= 80;
    } else {
      text(t(`${input.business.name} · Cotización ${input.folio} (continuación)`), MARGIN, y - 10, { size: 9, color: MUTED });
      y -= 34;
    }
    tableHeader();
  };

  newPage(true);

  for (const item of input.items) {
    const lines = wrapText(font, t(item.description), BODY, COLS.description.w);
    let index = 0;
    // Una línea larga puede partirse entre páginas; las cifras van en su
    // primer renglón.
    while (index < lines.length) {
      if (y - LINE < BOTTOM) newPage(false);
      if (index === 0) {
        right(t(formatQuantity(item.quantityMilli)), COLS.quantity, y);
        right(t(money(item.unitPriceCents, input.currency)), COLS.unit, y);
        right(t(money(item.lineTotalCents, input.currency)), COLS.total, y);
      }
      text(lines[index]!, COLS.description.x, y);
      y -= LINE;
      index += 1;
    }
    y -= 5;
  }

  // Bloque de totales: nunca se parte entre páginas.
  const totalsHeight = 4 * (LINE + 4) + 30;
  if (y - totalsHeight < BOTTOM) newPage(false);
  rule(y + LINE - 6);
  y -= 6;
  const labelCol = { x: COLS.quantity.x, w: COLS.unit.x + COLS.unit.w - COLS.quantity.x };
  const totalRow = (label: string, value: string, strong = false) => {
    right(t(label), labelCol, y, strong ? bold : font, strong ? 12 : BODY);
    right(t(value), COLS.total, y, strong ? bold : font, strong ? 12 : BODY);
    y -= strong ? LINE + 6 : LINE + 4;
  };
  const rate = formatTaxRate(input.taxRateBps);
  if (input.pricesIncludeTax) {
    totalRow("Subtotal (IVA incluido)", money(input.subtotalCents, input.currency));
    totalRow(`IVA ${rate} incluido`, money(input.taxCents, input.currency));
  } else {
    totalRow("Subtotal", money(input.subtotalCents, input.currency));
    totalRow(`IVA ${rate}`, money(input.taxCents, input.currency));
  }
  totalRow("Total", money(input.totalCents, input.currency), true);
  y -= 6;
  text(t(`Montos en ${input.currency}. Esta cotización no es un comprobante fiscal.`), MARGIN, y, { size: 8, color: MUTED });

  pages.forEach((p, i) => {
    const footer = t(`${input.folio} · Página ${i + 1} de ${pages.length}`);
    p.drawText(footer, {
      x: PAGE_W - MARGIN - font.widthOfTextAtSize(footer, 8),
      y: 32,
      size: 8,
      font,
      color: MUTED,
    });
    if (input.draft) {
      // Marca de agua en TODAS las páginas: una hoja suelta impresa de un
      // borrador tampoco debe pasar por cotización válida.
      const mark = "BORRADOR";
      const size = 96;
      const w = bold.widthOfTextAtSize(mark, size);
      p.drawText(mark, {
        x: PAGE_W / 2 - (w / 2) * Math.SQRT1_2 + (size / 2) * Math.SQRT1_2,
        y: PAGE_H / 2 - (w / 2) * Math.SQRT1_2 - (size / 2) * Math.SQRT1_2,
        size,
        font: bold,
        color: DRAFT_RED,
        opacity: 0.18,
        rotate: degrees(45),
      });
      const notice = "BORRADOR · Vista previa, no válida para aceptar";
      p.drawText(t(notice), { x: MARGIN, y: PAGE_H - 30, size: 9, font: bold, color: DRAFT_RED });
    }
  });

  return doc.save();
}
