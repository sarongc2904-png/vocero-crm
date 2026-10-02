import { asc, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { deleteKnowledgeFile } from "./storage";

type DocumentRow = typeof schema.kbDocument.$inferSelect;
type ChunkRow = typeof schema.kbDocumentChunk.$inferSelect;

export class KnowledgeDocumentLifecycleError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "KnowledgeDocumentLifecycleError";
  }
}

export function documentDto(document: DocumentRow) {
  const { storagePath: _storagePath, organizationId: _organizationId, ...safe } =
    document;
  return safe;
}

export function chunkDto(chunk: ChunkRow) {
  const { organizationId: _organizationId, documentId: _documentId, ...safe } =
    chunk;
  return safe;
}

export async function listKnowledgeDocuments(organizationId: string) {
  const rows = await getDb()
    .select()
    .from(schema.kbDocument)
    .where(scoped(schema.kbDocument.organizationId, organizationId))
    .orderBy(desc(schema.kbDocument.createdAt));
  return rows.map(documentDto);
}

async function findOwnedDocument(
  organizationId: string,
  documentId: string
): Promise<DocumentRow | null> {
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
}

export async function getKnowledgeDocument(
  organizationId: string,
  documentId: string
) {
  const document = await findOwnedDocument(organizationId, documentId);
  if (!document) return null;
  const chunks = await getDb()
    .select()
    .from(schema.kbDocumentChunk)
    .where(
      scoped(
        schema.kbDocumentChunk.organizationId,
        organizationId,
        eq(schema.kbDocumentChunk.documentId, documentId)
      )
    )
    .orderBy(asc(schema.kbDocumentChunk.position));
  return {
    document: documentDto(document),
    chunks: chunks.map(chunkDto),
  };
}

export async function approveKnowledgeDocument(
  organizationId: string,
  documentId: string
) {
  return getDb().transaction(async (tx) => {
    const documents = await tx
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
    const document = documents[0];
    if (!document) {
      throw new KnowledgeDocumentLifecycleError(
        404,
        "not_found",
        "Documento no encontrado"
      );
    }
    if (document.status !== "review") {
      throw new KnowledgeDocumentLifecycleError(
        409,
        "invalid_state",
        "Solo se puede aprobar un documento pendiente de revisión"
      );
    }

    const chunks = await tx
      .select({ id: schema.kbDocumentChunk.id })
      .from(schema.kbDocumentChunk)
      .where(
        scoped(
          schema.kbDocumentChunk.organizationId,
          organizationId,
          eq(schema.kbDocumentChunk.documentId, documentId)
        )
      );
    if (chunks.length === 0) {
      throw new KnowledgeDocumentLifecycleError(
        409,
        "no_chunks",
        "El documento no tiene fragmentos para aprobar"
      );
    }

    await tx
      .update(schema.kbDocumentChunk)
      .set({ approved: true })
      .where(
        scoped(
          schema.kbDocumentChunk.organizationId,
          organizationId,
          eq(schema.kbDocumentChunk.documentId, documentId)
        )
      );
    const updated = await tx
      .update(schema.kbDocument)
      .set({ status: "ready", error: null, updatedAt: new Date() })
      .where(
        scoped(
          schema.kbDocument.organizationId,
          organizationId,
          eq(schema.kbDocument.id, documentId),
          eq(schema.kbDocument.status, "review")
        )
      )
      .returning();
    if (!updated[0]) {
      throw new KnowledgeDocumentLifecycleError(
        409,
        "state_changed",
        "El estado del documento cambió; vuelve a cargar la pantalla"
      );
    }
    return documentDto(updated[0]);
  });
}

export async function deleteKnowledgeDocument(
  organizationId: string,
  documentId: string
) {
  const document = await findOwnedDocument(organizationId, documentId);
  if (!document) {
    throw new KnowledgeDocumentLifecycleError(
      404,
      "not_found",
      "Documento no encontrado"
    );
  }

  await deleteKnowledgeFile(organizationId, document.storagePath);
  const deleted = await getDb().transaction(async (tx) => {
    await tx
      .delete(schema.kbDocumentChunk)
      .where(
        scoped(
          schema.kbDocumentChunk.organizationId,
          organizationId,
          eq(schema.kbDocumentChunk.documentId, documentId)
        )
      );
    return tx
      .delete(schema.kbDocument)
      .where(
        scoped(
          schema.kbDocument.organizationId,
          organizationId,
          eq(schema.kbDocument.id, documentId)
        )
      )
      .returning();
  });
  if (!deleted[0]) {
    throw new KnowledgeDocumentLifecycleError(
      404,
      "not_found",
      "Documento no encontrado"
    );
  }
  return documentDto(deleted[0]);
}
