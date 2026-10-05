import type {
  CompleteApprovedDocumentChunk,
  CompleteDocumentSourceFailureReason,
} from "./retrieval";

export type ManualPriceSourceEntry = {
  id: string;
  text: string;
};

export type PriceSourceFailureReason =
  | "malformed_price_line"
  | "no_price_lines"
  | "truncated_price_line"
  | "conflicting_price"
  | "load_error"
  | CompleteDocumentSourceFailureReason;

export type CompletePriceSourceResult =
  | { complete: true; lines: string[] }
  | {
      complete: false;
      lines: [];
      reason: PriceSourceFailureReason;
      documentId: string;
    };

type PriceCandidate = {
  line: string;
  normalized: string;
  service: string;
  sourceId: string;
  documentId: string;
  boundary: "first" | "last" | null;
};

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim()
    .toLowerCase();
}

const PRICE_NUMBER = String.raw`\d(?:[\d.,]*\d)?`;
const PRICE_APPEARANCE = new RegExp(
  String.raw`(?:\$\s*${PRICE_NUMBER}|${PRICE_NUMBER}\s*(?:pesos|mxn|mn)\b|\b(?:pesos|mxn|mn)\s*${PRICE_NUMBER})`,
  "i"
);
const PRICE_LIST_MARKER = /^(?:[-•*]|\d+[.)])(?:\s|$)/;
// Separa entradas concisas de catálogo de prosa narrativa: el demo mide
// 27–50 caracteres por precio; sus líneas narrativas miden 72 y 186.
const SHORT_PRICE_LINE_MAX_LENGTH = 60;

function hasPriceAppearance(value: string): boolean {
  return PRICE_APPEARANCE.test(value.normalize("NFKC"));
}

function hasMalformedPriceEntryShape(value: string): boolean {
  const line = value.trim();
  return (
    hasPriceAppearance(line) &&
    (PRICE_LIST_MARKER.test(line) || line.includes("|") || line.length <= SHORT_PRICE_LINE_MAX_LENGTH)
  );
}

// Línea larga sin viñeta cuyo ÚLTIMO elemento es el monto con signo de pesos
// (moneda opcional). Sin punto final ni nada después: si no, es prosa.
const TRAILING_PRICE = new RegExp(
  String.raw`^(.*?)\s*\$\s*${PRICE_NUMBER}(?:\s*(?:pesos|mxn|mn))?$`,
  "i"
);

function unmarkedPriceCandidate(
  line: string,
  sourceId: string,
  documentId: string,
  boundary: PriceCandidate["boundary"]
): PriceCandidate | null {
  if (
    line.length <= SHORT_PRICE_LINE_MAX_LENGTH ||
    PRICE_LIST_MARKER.test(line) ||
    line.includes("|")
  ) {
    return null;
  }
  const service = TRAILING_PRICE.exec(line.normalize("NFKC"))?.[1]
    ?.replace(/[\s:–—-]+$/, "")
    .trim();
  // Ambigua → se ignora: sin servicio legible o con otro monto antes del final.
  if (!service || !/\p{L}/u.test(service) || hasPriceAppearance(service)) return null;
  return {
    line,
    normalized: normalize(line),
    service: normalize(service),
    sourceId,
    documentId,
    boundary,
  };
}

function priceCandidate(
  raw: string,
  sourceId: string,
  documentId: string,
  boundary: PriceCandidate["boundary"]
): PriceCandidate | "malformed" | null {
  const line = raw.trim();
  if (!/^-\s*/.test(line)) return unmarkedPriceCandidate(line, sourceId, documentId, boundary);
  if (!/\$\s*\d/.test(line)) return null;
  const colon = line.indexOf(":");
  if (
    colon <= 1 ||
    line.slice(1, colon).trim().length === 0 ||
    !/\$\s*\d/.test(line.slice(colon + 1))
  ) {
    return "malformed";
  }
  return {
    line,
    normalized: normalize(line),
    service: normalize(line.slice(1, colon)),
    sourceId,
    documentId,
    boundary,
  };
}

export function extractPriceLinesFromText(text: string): {
  lines: string[];
  complete: boolean;
} {
  const seen = new Set<string>();
  const lines: string[] = [];
  let complete = true;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.includes("|") && hasPriceAppearance(raw)) {
      complete = false;
      continue;
    }
    const candidate = priceCandidate(raw, "text", "manual", null);
    if (candidate === "malformed" || (!candidate && hasMalformedPriceEntryShape(raw))) {
      complete = false;
      continue;
    }
    if (!candidate || seen.has(candidate.normalized)) continue;
    seen.add(candidate.normalized);
    lines.push(candidate.line);
  }
  return { lines, complete: complete && lines.length > 0 };
}

function overlapLength(left: string, right: string): number {
  const maximum = Math.min(left.length, right.length, 200);
  for (let length = maximum; length > 0; length -= 1) {
    if (left.slice(-length) === right.slice(0, length)) return length;
  }
  return 0;
}

function failure(
  reason: PriceSourceFailureReason,
  documentId: string
): CompletePriceSourceResult {
  return { complete: false, lines: [], reason, documentId };
}

export function buildCompletePriceSource(input: {
  organizationId: string;
  manualEntries: ManualPriceSourceEntry[];
  documentChunks: CompleteApprovedDocumentChunk[];
}): CompletePriceSourceResult {
  const candidates: PriceCandidate[] = [];
  const uniqueManualTexts = new Set<string>();
  for (const entry of input.manualEntries) {
    const textKey = normalize(entry.text);
    if (!textKey || uniqueManualTexts.has(textKey)) continue;
    uniqueManualTexts.add(textKey);
    const lines = entry.text.split(/\r?\n/);
    for (const raw of lines) {
      if (raw.includes("|") && hasPriceAppearance(raw)) {
        return failure("malformed_price_line", `manual:${entry.id}`);
      }
      const candidate = priceCandidate(raw, entry.id, `manual:${entry.id}`, null);
      if (candidate === "malformed" || (!candidate && hasMalformedPriceEntryShape(raw))) {
        return failure("malformed_price_line", `manual:${entry.id}`);
      }
      if (candidate) candidates.push(candidate);
    }
  }

  const byDocument = new Map<string, CompleteApprovedDocumentChunk[]>();
  for (const chunk of input.documentChunks) {
    if (chunk.organizationId !== input.organizationId) {
      return failure("truncated_price_line", chunk.documentId);
    }
    const group = byDocument.get(chunk.documentId) ?? [];
    group.push(chunk);
    byDocument.set(chunk.documentId, group);
  }

  for (const [documentId, unordered] of byDocument) {
    const chunks = [...unordered].sort((a, b) => a.position - b.position);
    const documentCandidates: PriceCandidate[] = [];
    const rawLines: string[] = [];
    let hasUnparsedPriceEntryShape = false;
    for (const chunk of chunks) {
      const lines = chunk.content.split(/\r?\n/);
      for (const [index, raw] of lines.entries()) {
        const trimmed = raw.trim();
        if (trimmed) rawLines.push(trimmed);
        const boundary = index === 0 ? "first" : index === lines.length - 1 ? "last" : null;
        if (raw.includes("|") && hasPriceAppearance(raw)) {
          return failure("malformed_price_line", documentId);
        }
        const candidate = priceCandidate(raw, chunk.id, documentId, boundary);
        if (candidate === "malformed") {
          return failure("malformed_price_line", documentId);
        }
        if (!candidate && hasMalformedPriceEntryShape(raw)) {
          hasUnparsedPriceEntryShape = true;
        }
        if (candidate) documentCandidates.push(candidate);
      }
    }

    const normalizedLines = [...new Set(rawLines.map(normalize))];
    const retained = documentCandidates.filter((candidate) => {
      if (candidate.boundary === null) return true;
      return !normalizedLines.some(
        (line) =>
          line.length > candidate.normalized.length &&
          (line.startsWith(candidate.normalized) || line.endsWith(candidate.normalized))
      );
    });

    for (let index = 0; index < chunks.length - 1; index += 1) {
      const left = chunks[index]!;
      const right = chunks[index + 1]!;
      if (left.page !== right.page) continue;
      const leftLast = left.content.split(/\r?\n/).at(-1)?.trim() ?? "";
      const rightFirst = right.content.split(/\r?\n/)[0]?.trim() ?? "";
      const overlap = overlapLength(leftLast, rightFirst);
      if (overlap === 0) continue;
      const combined = `${leftLast}${rightFirst.slice(overlap)}`;
      if (!/\$\s*\d/.test(combined)) continue;
      const parsedCombined = priceCandidate(combined, left.id, documentId, null);
      if (parsedCombined === "malformed") {
        return failure("truncated_price_line", documentId);
      }
      if (
        parsedCombined &&
        !normalizedLines.some((line) => line === parsedCombined.normalized)
      ) {
        return failure("truncated_price_line", documentId);
      }
    }

    for (const candidate of documentCandidates) {
      if (candidate.boundary === "first" && /\$\s*\d/.test(candidate.line)) {
        const retainedHere = retained.some(
          (item) => item.sourceId === candidate.sourceId && item.normalized === candidate.normalized
        );
        const completeElsewhere = normalizedLines.some(
          (line) => line.length >= candidate.normalized.length && line.endsWith(candidate.normalized)
        );
        if (!retainedHere && !completeElsewhere) {
          return failure("truncated_price_line", documentId);
        }
      }
    }
    if (hasUnparsedPriceEntryShape) {
      return failure("malformed_price_line", documentId);
    }
    candidates.push(...retained);
  }

  const byService = new Map<string, PriceCandidate>();
  const seenLines = new Set<string>();
  const lines: string[] = [];
  for (const candidate of candidates) {
    const existing = byService.get(candidate.service);
    if (existing && existing.normalized !== candidate.normalized) {
      return failure("conflicting_price", candidate.documentId);
    }
    byService.set(candidate.service, existing ?? candidate);
    if (seenLines.has(candidate.normalized)) continue;
    seenLines.add(candidate.normalized);
    lines.push(candidate.line);
  }
  return lines.length > 0 ? { complete: true, lines } : failure("no_price_lines", "all");
}
