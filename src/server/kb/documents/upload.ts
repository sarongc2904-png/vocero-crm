import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { deleteKnowledgeFile, saveKnowledgeFile } from "./storage";
import { processKnowledgeDocument } from "./processing";
import type { ValidatedKnowledgeUpload } from "./validation";

export async function createAndProcessKnowledgeDocument(
  organizationId: string,
  upload: ValidatedKnowledgeUpload
) {
  const id = newId("kbDocument");
  const storagePath = await saveKnowledgeFile(
    organizationId,
    id,
    upload.extension,
    upload.bytes
  );

  try {
    const inserted = await getDb()
      .insert(schema.kbDocument)
      .values({
        id,
        organizationId,
        filename: upload.filename,
        mimeType: upload.mimeType,
        fileSize: upload.bytes.length,
        storagePath,
        status: "uploaded",
      })
      .returning();
    if (!inserted[0]) throw new Error("No se pudo registrar el documento");
  } catch (error) {
    await deleteKnowledgeFile(organizationId, storagePath).catch(() => false);
    throw error;
  }

  return processKnowledgeDocument(organizationId, id, upload.bytes);
}
