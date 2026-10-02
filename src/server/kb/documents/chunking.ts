export const DOCUMENT_CHUNK_TARGET = 1_500;
export const DOCUMENT_CHUNK_MAX = 1_800;
export const DOCUMENT_CHUNK_MIN = 1_200;
export const DOCUMENT_CHUNK_OVERLAP = 200;

export type DocumentChunkDraft = {
  content: string;
  position: number;
  page: number | null;
  approved: false;
};

export function normalizeDocumentText(input: string): string {
  return input
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function lastBoundary(
  text: string,
  start: number,
  minimum: number,
  maximum: number,
  separator: string
): number | null {
  const found = text.lastIndexOf(separator, maximum);
  return found >= minimum && found > start ? found + separator.length : null;
}

function sentenceBoundary(
  text: string,
  minimum: number,
  maximum: number
): number | null {
  const window = text.slice(minimum, maximum);
  const pattern = /[.!?](?:["”')\]]*)\s+/g;
  let boundary: number | null = null;
  for (const match of window.matchAll(pattern)) {
    boundary = minimum + (match.index ?? 0) + match[0].length;
  }
  return boundary;
}

function chooseCut(text: string, start: number): number {
  const hardEnd = Math.min(text.length, start + DOCUMENT_CHUNK_MAX);
  if (hardEnd === text.length) return hardEnd;
  const minimum = Math.min(hardEnd, start + DOCUMENT_CHUNK_MIN);
  const preferred = Math.min(hardEnd, start + DOCUMENT_CHUNK_TARGET);

  return (
    lastBoundary(text, start, minimum, preferred, "\n\n") ??
    lastBoundary(text, start, minimum, preferred, "\n") ??
    sentenceBoundary(text, minimum, preferred) ??
    hardEnd
  );
}

export function chunkDocumentText(
  input: string,
  page: number | null = null,
  positionOffset = 0
): DocumentChunkDraft[] {
  const text = normalizeDocumentText(input);
  if (!text) return [];

  const chunks: DocumentChunkDraft[] = [];
  let start = 0;
  while (start < text.length) {
    const end = chooseCut(text, start);
    const content = text.slice(start, end).trim();
    if (content) {
      chunks.push({
        content,
        position: positionOffset + chunks.length,
        page,
        approved: false,
      });
    }
    if (end >= text.length) break;
    start = Math.max(start + 1, end - DOCUMENT_CHUNK_OVERLAP);
  }
  return chunks;
}
