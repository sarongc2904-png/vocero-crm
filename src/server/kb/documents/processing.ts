import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { chunkDocumentText, type DocumentChunkDraft } from "./chunking";
import {
  DocumentExtractionError,
  extractDocumentPages,
  type ExtractedDocumentPage,
} from "./extraction";
import { readKnowledgeFile } from "./storage";

export type KnowledgeDocumentRecord = typeof schema.kbDocument.$inferSelect;

export interface KnowledgeProcessingStore {
  findDocument(
    organizationId: string,
    documentId: string
  ): Promise<KnowledgeDocumentRecord | null>;
  markProcessing(
    organizationId: string,
    documentId: string
  ): Promise<KnowledgeDocumentRecord | null>;
  replaceChunksAndReview(
    organizationId: string,
    documentId: string,
    chunks: DocumentChunkDraft[]
  ): Promise<KnowledgeDocumentRecord | null>;
  failAndClear(
    organizationId: string,
    documentId: string,
    error: string
  ): Promise<KnowledgeDocumentRecord | null>;
}

export class KnowledgeDocumentNotFoundError extends Error {
  constructor() {
    super("Documento no encontrado");
    this.name = "KnowledgeDocumentNotFoundError";
  }
}

const drizzleStore: KnowledgeProcessingStore = {
  async findDocument(organizationId, documentId) {
    const rows = await getDb()
      .select()
      .from(schema.kbDocument)
      .where(
        scoped(
          schema.kbDocument.organizationId,
          organizationId,
          eq(schema.kbDocument.id, documentId)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async markProcessing(organizationId, documentId) {
    const rows = await getDb()
      .update(schema.kbDocument)
      .set({ status: "processing", error: null, updatedAt: new Date() })
      .where(
        scoped(
          schema.kbDocument.organizationId,
          organizationId,
          eq(schema.kbDocument.id, documentId)
        )
      )
      .returning();
    return rows[0] ?? null;
  },
  async replaceChunksAndReview(organizationId, documentId, chunks) {
    return getDb().transaction(async (tx) => {
      await tx
        .delete(schema.kbDocumentChunk)
        .where(
          scoped(
            schema.kbDocumentChunk.organizationId,
            organizationId,
            eq(schema.kbDocumentChunk.documentId, documentId)
          )
        );
      await tx.insert(schema.kbDocumentChunk).values(
        chunks.map((chunk) => ({
          id: newId("kbDocumentChunk"),
          organizationId,
          documentId,
          ...chunk,
        }))
      );
      const rows = await tx
        .update(schema.kbDocument)
        .set({ status: "review", error: null, updatedAt: new Date() })
        .where(
          scoped(
            schema.kbDocument.organizationId,
            organizationId,
            eq(schema.kbDocument.id, documentId)
          )
        )
        .returning();
      return rows[0] ?? null;
    });
  },
  async failAndClear(organizationId, documentId, error) {
    return getDb().transaction(async (tx) => {
      await tx
        .delete(schema.kbDocumentChunk)
        .where(
          scoped(
            schema.kbDocumentChunk.organizationId,
            organizationId,
            eq(schema.kbDocumentChunk.documentId, documentId)
          )
        );
      const rows = await tx
        .update(schema.kbDocument)
        .set({ status: "failed", error, updatedAt: new Date() })
        .where(
          scoped(
            schema.kbDocument.organizationId,
            organizationId,
            eq(schema.kbDocument.id, documentId)
          )
        )
        .returning();
      return rows[0] ?? null;
    });
  },
};

function chunksFromPages(pages: ExtractedDocumentPage[]): DocumentChunkDraft[] {
  const chunks: DocumentChunkDraft[] = [];
  for (const page of pages) {
    chunks.push(...chunkDocumentText(page.content, page.page, chunks.length));
  }
  return chunks;
}

function publicError(error: unknown): string {
  return error instanceof DocumentExtractionError
    ? error.message.slice(0, 240)
    : "No se pudo extraer el contenido del documento.";
}

export async function processKnowledgeDocumentWithStore(
  store: KnowledgeProcessingStore,
  organizationId: string,
  documentId: string,
  bytes: Buffer | (() => Promise<Buffer>),
  extractor = extractDocumentPages
): Promise<KnowledgeDocumentRecord> {
  const owned = await store.findDocument(organizationId, documentId);
  if (!owned) throw new KnowledgeDocumentNotFoundError();
  const processing = await store.markProcessing(organizationId, documentId);
  if (!processing) throw new KnowledgeDocumentNotFoundError();

  try {
    const data = typeof bytes === "function" ? await bytes() : bytes;
    const pages = await extractor(processing.mimeType as "text/plain" | "application/pdf", data);
    const chunks = chunksFromPages(pages);
    if (chunks.length === 0) {
      throw new DocumentExtractionError(
        processing.mimeType === "application/pdf"
          ? "Este PDF no contiene texto extraíble. Usa un PDF con texto seleccionable."
          : "El archivo TXT no contiene texto."
      );
    }
    const reviewed = await store.replaceChunksAndReview(
      organizationId,
      documentId,
      chunks
    );
    if (!reviewed) throw new KnowledgeDocumentNotFoundError();
    return reviewed;
  } catch (error) {
    const failed = await store.failAndClear(
      organizationId,
      documentId,
      publicError(error)
    );
    if (!failed) throw new KnowledgeDocumentNotFoundError();
    return failed;
  }
}

export async function processKnowledgeDocument(
  organizationId: string,
  documentId: string,
  bytes?: Buffer
): Promise<KnowledgeDocumentRecord> {
  const document = await drizzleStore.findDocument(organizationId, documentId);
  if (!document) throw new KnowledgeDocumentNotFoundError();
  const data =
    bytes ?? (() => readKnowledgeFile(organizationId, document.storagePath));
  return processKnowledgeDocumentWithStore(
    drizzleStore,
    organizationId,
    documentId,
    data
  );
}
