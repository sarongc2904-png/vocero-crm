import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";

const CANDIDATE_LIMIT = 400;

const SPANISH_STOPWORDS = new Set([
  "con",
  "del",
  "desde",
  "donde",
  "el",
  "ella",
  "en",
  "es",
  "esta",
  "este",
  "hay",
  "la",
  "las",
  "los",
  "para",
  "por",
  "que",
  "se",
  "sin",
  "son",
  "sus",
  "una",
  "uno",
  "unos",
  "unas",
  "y",
]);

export type DocumentRetrievalCandidate = {
  id: string;
  organizationId: string;
  documentId: string;
  documentStatus: string;
  approved: boolean;
  content: string;
  position: number;
  page: number | null;
};

export type RetrievedDocumentChunk = Pick<
  DocumentRetrievalCandidate,
  "id" | "documentId" | "content" | "position" | "page"
> & { score: number };

export type DocumentRetrievalInput = {
  organizationId: string;
  query: string;
  maxChunks: number;
  maxCharacters: number;
};

export type DocumentRetrievalStore = {
  loadCandidates(
    organizationId: string,
    limit: number
  ): Promise<DocumentRetrievalCandidate[]>;
};

function normalizedTokens(value: string): string[] {
  return (
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  ).filter((token) => token.length >= 3 && !SPANISH_STOPWORDS.has(token));
}

function duplicateKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function scoreContent(content: string, terms: Set<string>): number {
  const frequencies = new Map<string, number>();
  for (const token of normalizedTokens(content)) {
    if (terms.has(token)) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
  }
  if (frequencies.size === 0) return 0;

  let score = 0;
  for (const frequency of frequencies.values()) score += Math.min(frequency, 3);
  if (frequencies.size > 1) score += frequencies.size * 2;
  return score;
}

export function rankDocumentChunks(
  candidates: DocumentRetrievalCandidate[],
  input: DocumentRetrievalInput
): RetrievedDocumentChunk[] {
  const terms = new Set(normalizedTokens(input.query));
  if (terms.size === 0 || input.maxChunks <= 0 || input.maxCharacters <= 0) {
    return [];
  }

  const ranked = candidates
    .filter(
      (candidate) =>
        candidate.organizationId === input.organizationId &&
        candidate.documentStatus === "ready" &&
        candidate.approved
    )
    .map((candidate) => ({
      ...candidate,
      content: candidate.content.trim(),
      score: scoreContent(candidate.content, terms),
    }))
    .filter((candidate) => candidate.content.length > 0 && candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.position - right.position ||
        left.documentId.localeCompare(right.documentId) ||
        left.id.localeCompare(right.id)
    );

  const selected: RetrievedDocumentChunk[] = [];
  const seen = new Set<string>();
  let usedCharacters = 0;
  for (const candidate of ranked) {
    const key = duplicateKey(candidate.content);
    if (seen.has(key)) continue;
    if (selected.length >= input.maxChunks) break;
    if (usedCharacters + candidate.content.length > input.maxCharacters) continue;
    seen.add(key);
    usedCharacters += candidate.content.length;
    selected.push({
      id: candidate.id,
      documentId: candidate.documentId,
      content: candidate.content,
      position: candidate.position,
      page: candidate.page,
      score: candidate.score,
    });
  }
  return selected;
}

const databaseStore: DocumentRetrievalStore = {
  async loadCandidates(organizationId, limit) {
    return getDb()
      .select({
        id: schema.kbDocumentChunk.id,
        organizationId: schema.kbDocumentChunk.organizationId,
        documentId: schema.kbDocumentChunk.documentId,
        documentStatus: schema.kbDocument.status,
        approved: schema.kbDocumentChunk.approved,
        content: schema.kbDocumentChunk.content,
        position: schema.kbDocumentChunk.position,
        page: schema.kbDocumentChunk.page,
      })
      .from(schema.kbDocumentChunk)
      .innerJoin(
        schema.kbDocument,
        and(
          eq(schema.kbDocument.organizationId, schema.kbDocumentChunk.organizationId),
          eq(schema.kbDocument.id, schema.kbDocumentChunk.documentId)
        )
      )
      .where(
        scoped(
          schema.kbDocumentChunk.organizationId,
          organizationId,
          eq(schema.kbDocument.organizationId, organizationId),
          eq(schema.kbDocument.status, "ready"),
          eq(schema.kbDocumentChunk.approved, true)
        )
      )
      .orderBy(
        asc(schema.kbDocumentChunk.position),
        asc(schema.kbDocumentChunk.documentId)
      )
      .limit(limit);
  },
};

export async function retrieveRelevantDocumentChunksWithStore(
  store: DocumentRetrievalStore,
  input: DocumentRetrievalInput
): Promise<RetrievedDocumentChunk[]> {
  if (!input.organizationId) throw new Error("organizationId_required");
  const candidates = await store.loadCandidates(input.organizationId, CANDIDATE_LIMIT);
  return rankDocumentChunks(candidates, input);
}

/**
 * Recuperación lexical acotada: Postgres filtra tenant/estado/aprobación y
 * Node puntúa como máximo CANDIDATE_LIMIT filas, sin llamadas externas.
 */
export async function retrieveRelevantDocumentChunks(
  input: DocumentRetrievalInput
): Promise<RetrievedDocumentChunk[]> {
  return retrieveRelevantDocumentChunksWithStore(databaseStore, input);
}
