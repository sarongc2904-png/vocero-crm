import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";

const CANDIDATE_LIMIT = 400;
const COMPLETE_SOURCE_MAX_CHUNKS = 2_000;
const COMPLETE_SOURCE_MAX_CHARACTERS = 2_000_000;

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
  /**
   * Mensajes previos del cliente. Pesan menos que el turno actual y sólo
   * sirven para que un follow-up ("¿Qué incluye cada una?") conserve el tema.
   */
  contextQuery?: string;
  maxChunks: number;
  maxCharacters: number;
};

export type DocumentRetrievalStore = {
  loadCandidates(
    organizationId: string,
    limit: number
  ): Promise<DocumentRetrievalCandidate[]>;
};

export type CompleteDocumentSourcePreflight = {
  documentCount: number;
  chunkCount: number;
  totalCharacters: number;
};

export type CompleteDocumentChunkRow = {
  id: string | null;
  organizationId: string;
  documentId: string;
  documentStatus: string;
  approved: boolean | null;
  content: string | null;
  position: number | null;
  page: number | null;
};

export type CompleteApprovedDocumentChunk = {
  id: string;
  organizationId: string;
  documentId: string;
  content: string;
  position: number;
  page: number | null;
};

export type CompleteDocumentSourceFailureReason =
  | "corpus_limit"
  | "tenant_mismatch"
  | "document_not_ready"
  | "missing_chunks"
  | "chunk_not_approved"
  | "position_duplicate"
  | "position_gap"
  | "preflight_mismatch";

export type CompleteDocumentSourceResult =
  | { complete: true; chunks: CompleteApprovedDocumentChunk[] }
  | {
      complete: false;
      chunks: [];
      reason: CompleteDocumentSourceFailureReason;
      documentId: string;
    };

export type CompleteDocumentSourceStore = {
  loadPreflight(organizationId: string): Promise<CompleteDocumentSourcePreflight>;
  loadRows(organizationId: string): Promise<CompleteDocumentChunkRow[]>;
};

/**
 * Familias comerciales: el cliente pregunta "\u00bfcu\u00e1nto cuesta?" y el documento
 * dice "PRECIOS DE REFERENCIA \u2026 $700 MXN". Se canonicalizan igual en consulta
 * y contenido. Deliberadamente excluye palabras ambiguas ("vale", "sale").
 */
const CONCEPT_BY_STEM = new Map<string, string>([
  ...["precio", "costo", "cuesta", "cuestan", "costar", "tarifa", "cotizacion", "cotizar", "mxn", "usd"].map(
    (stem) => [stem, "precio"] as const
  ),
  ...["servicio", "opcion", "tratamiento", "paquete", "producto"].map(
    (stem) => [stem, "servicio"] as const
  ),
  ...["incluye", "incluyen", "incluir", "incluido", "incluida", "contiene", "contienen"].map(
    (stem) => [stem, "incluir"] as const
  ),
  ...["descuento", "promocion", "promo", "rebaja"].map(
    (stem) => [stem, "descuento"] as const
  ),
]);

/** Plural simple: "opciones" \u2192 "opcion", "precios" \u2192 "precio". */
function stem(token: string): string {
  if (token.length > 4 && /[^aeiou]es$/.test(token)) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function normalizedTokens(value: string): string[] {
  return (
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      // "sale"/"vale"/"cobra" s\u00f3lo significan precio detr\u00e1s de "cu\u00e1nto".
      .replace(/\bcuantos?\s+(sale|salen|vale|valen|cobra|cobran)\b/g, "cuanto cuesta")
      .match(/[a-z0-9]+/g) ?? []
  )
    .filter((token) => token.length >= 3 && !SPANISH_STOPWORDS.has(token))
    .map((token) => {
      const stemmed = stem(token);
      return CONCEPT_BY_STEM.get(stemmed) ?? stemmed;
    });
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
  const contextTerms = new Set(
    normalizedTokens(input.contextQuery ?? "").filter((term) => !terms.has(term))
  );
  if (
    (terms.size === 0 && contextTerms.size === 0) ||
    input.maxChunks <= 0 ||
    input.maxCharacters <= 0
  ) {
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
      currentScore: scoreContent(candidate.content, terms),
      contextScore: scoreContent(candidate.content, contextTerms),
    }))
    // El turno actual manda: todo fragmento que coincide con él va antes que
    // uno que sólo coincide con el contexto previo, que únicamente desempata o
    // rescata follow-ups que por sí solos no nombran el tema.
    .map((candidate) => ({
      ...candidate,
      score: candidate.currentScore > 0 ? candidate.currentScore : candidate.contextScore,
    }))
    .filter((candidate) => candidate.content.length > 0 && candidate.score > 0)
    .sort(
      (left, right) =>
        right.currentScore - left.currentScore ||
        right.contextScore - left.contextScore ||
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

function numeric(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

const completeSourceDatabaseStore: CompleteDocumentSourceStore = {
  async loadPreflight(organizationId) {
    const rows = await getDb()
      .select({
        documentCount: sql<number>`count(distinct ${schema.kbDocument.id})::int`,
        chunkCount: sql<number>`count(${schema.kbDocumentChunk.id})::int`,
        totalCharacters: sql<number>`coalesce(sum(length(${schema.kbDocumentChunk.content})), 0)::int`,
      })
      .from(schema.kbDocument)
      .leftJoin(
        schema.kbDocumentChunk,
        and(
          eq(schema.kbDocument.organizationId, schema.kbDocumentChunk.organizationId),
          eq(schema.kbDocument.id, schema.kbDocumentChunk.documentId),
          eq(schema.kbDocumentChunk.organizationId, organizationId)
        )
      )
      .where(
        scoped(
          schema.kbDocument.organizationId,
          organizationId,
          eq(schema.kbDocument.status, "ready")
        )
      );
    const row = rows[0];
    return {
      documentCount: numeric(row?.documentCount),
      chunkCount: numeric(row?.chunkCount),
      totalCharacters: numeric(row?.totalCharacters),
    };
  },
  async loadRows(organizationId) {
    return getDb()
      .select({
        id: schema.kbDocumentChunk.id,
        organizationId: schema.kbDocument.organizationId,
        documentId: schema.kbDocument.id,
        documentStatus: schema.kbDocument.status,
        approved: schema.kbDocumentChunk.approved,
        content: schema.kbDocumentChunk.content,
        position: schema.kbDocumentChunk.position,
        page: schema.kbDocumentChunk.page,
      })
      .from(schema.kbDocument)
      .leftJoin(
        schema.kbDocumentChunk,
        and(
          eq(schema.kbDocument.organizationId, schema.kbDocumentChunk.organizationId),
          eq(schema.kbDocument.id, schema.kbDocumentChunk.documentId),
          eq(schema.kbDocumentChunk.organizationId, organizationId)
        )
      )
      .where(
        scoped(
          schema.kbDocument.organizationId,
          organizationId,
          eq(schema.kbDocument.status, "ready")
        )
      )
      .orderBy(asc(schema.kbDocument.id), asc(schema.kbDocumentChunk.position));
  },
};

function completeSourceFailure(
  reason: CompleteDocumentSourceFailureReason,
  documentId = "all"
): CompleteDocumentSourceResult {
  return { complete: false, chunks: [], reason, documentId };
}

function characterLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      index += 1;
    }
    length += 1;
  }
  return length;
}

export async function loadCompleteApprovedDocumentChunksWithStore(
  store: CompleteDocumentSourceStore,
  input: { organizationId: string }
): Promise<CompleteDocumentSourceResult> {
  if (!input.organizationId) throw new Error("organizationId_required");
  const preflight = await store.loadPreflight(input.organizationId);
  if (
    preflight.chunkCount > COMPLETE_SOURCE_MAX_CHUNKS ||
    preflight.totalCharacters > COMPLETE_SOURCE_MAX_CHARACTERS
  ) {
    return completeSourceFailure("corpus_limit");
  }
  if (preflight.documentCount === 0) {
    if (preflight.chunkCount !== 0 || preflight.totalCharacters !== 0) {
      return completeSourceFailure("preflight_mismatch");
    }
    return { complete: true, chunks: [] };
  }

  const rows = await store.loadRows(input.organizationId);
  const byDocument = new Map<string, CompleteDocumentChunkRow[]>();
  for (const row of rows) {
    if (row.organizationId !== input.organizationId) {
      return completeSourceFailure("tenant_mismatch", row.documentId);
    }
    if (row.documentStatus !== "ready") {
      return completeSourceFailure("document_not_ready", row.documentId);
    }
    const group = byDocument.get(row.documentId) ?? [];
    group.push(row);
    byDocument.set(row.documentId, group);
  }
  if (byDocument.size !== preflight.documentCount) {
    return completeSourceFailure("preflight_mismatch");
  }

  const chunks: CompleteApprovedDocumentChunk[] = [];
  for (const [documentId, group] of [...byDocument.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (
      group.length === 0 ||
      group.some(
        (row) => row.id === null || row.content === null || row.position === null
      )
    ) {
      return completeSourceFailure("missing_chunks", documentId);
    }
    const ordered = [...group].sort(
      (left, right) => left.position! - right.position! || left.id!.localeCompare(right.id!)
    );
    const seenPositions = new Set<number>();
    for (let index = 0; index < ordered.length; index += 1) {
      const row = ordered[index]!;
      if (row.approved !== true) {
        return completeSourceFailure("chunk_not_approved", documentId);
      }
      if (seenPositions.has(row.position!)) {
        return completeSourceFailure("position_duplicate", documentId);
      }
      seenPositions.add(row.position!);
      if (row.position !== index) {
        return completeSourceFailure("position_gap", documentId);
      }
      chunks.push({
        id: row.id!,
        organizationId: row.organizationId,
        documentId,
        content: row.content!,
        position: row.position!,
        page: row.page,
      });
    }
  }
  if (
    chunks.length !== preflight.chunkCount ||
    chunks.reduce((total, chunk) => total + characterLength(chunk.content), 0) !==
      preflight.totalCharacters
  ) {
    return completeSourceFailure("preflight_mismatch");
  }
  return { complete: true, chunks };
}

export async function loadCompleteApprovedDocumentChunks(input: {
  organizationId: string;
}): Promise<CompleteDocumentSourceResult> {
  return loadCompleteApprovedDocumentChunksWithStore(completeSourceDatabaseStore, input);
}

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
