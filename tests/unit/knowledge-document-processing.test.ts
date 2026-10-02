import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { DocumentChunkDraft } from "@/server/kb/documents/chunking";
import {
  KnowledgeDocumentNotFoundError,
  processKnowledgeDocumentWithStore,
  type KnowledgeDocumentRecord,
  type KnowledgeProcessingStore,
} from "@/server/kb/documents/processing";
import { PDF_NO_TEXT_MESSAGE } from "@/server/kb/documents/extraction";
import {
  MAX_KNOWLEDGE_FILE_BYTES,
  KnowledgeUploadError,
  validateKnowledgeUpload,
  type KnowledgeUploadFile,
} from "@/server/kb/documents/validation";

function uploadFile(
  name: string,
  type: string,
  bytes: Buffer,
  size = bytes.length
): KnowledgeUploadFile {
  return {
    name,
    type,
    size,
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  };
}

function makePdf(text?: string): Buffer {
  const escaped = text?.replace(/([\\()])/g, "\\$1") ?? "";
  const stream = text
    ? `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`
    : "q 0 0 20 20 re f Q";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function documentRow(
  organizationId: string,
  mimeType: "text/plain" | "application/pdf",
  id = "kbd_1"
): KnowledgeDocumentRecord {
  return {
    id,
    organizationId,
    filename: mimeType === "text/plain" ? "datos.txt" : "datos.pdf",
    mimeType,
    fileSize: 100,
    storagePath: `${organizationId}/${id}${mimeType === "text/plain" ? ".txt" : ".pdf"}`,
    status: "uploaded",
    error: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-01T00:00:00Z"),
  };
}

class MemoryStore implements KnowledgeProcessingStore {
  readonly documents = new Map<string, KnowledgeDocumentRecord>();
  readonly chunks = new Map<string, DocumentChunkDraft[]>();
  readonly states: string[] = [];

  constructor(document: KnowledgeDocumentRecord) {
    this.documents.set(`${document.organizationId}:${document.id}`, document);
    this.states.push(document.status);
  }

  private key(organizationId: string, documentId: string) {
    return `${organizationId}:${documentId}`;
  }

  async findDocument(organizationId: string, documentId: string) {
    return this.documents.get(this.key(organizationId, documentId)) ?? null;
  }

  async markProcessing(organizationId: string, documentId: string) {
    const current = await this.findDocument(organizationId, documentId);
    if (!current) return null;
    const next = { ...current, status: "processing" as const, error: null };
    this.documents.set(this.key(organizationId, documentId), next);
    this.states.push(next.status);
    return next;
  }

  async replaceChunksAndReview(
    organizationId: string,
    documentId: string,
    chunks: DocumentChunkDraft[]
  ) {
    const current = await this.findDocument(organizationId, documentId);
    if (!current) return null;
    this.chunks.set(this.key(organizationId, documentId), structuredClone(chunks));
    const next = { ...current, status: "review" as const, error: null };
    this.documents.set(this.key(organizationId, documentId), next);
    this.states.push(next.status);
    return next;
  }

  async failAndClear(
    organizationId: string,
    documentId: string,
    error: string
  ) {
    const current = await this.findDocument(organizationId, documentId);
    if (!current) return null;
    this.chunks.delete(this.key(organizationId, documentId));
    const next = { ...current, status: "failed" as const, error };
    this.documents.set(this.key(organizationId, documentId), next);
    this.states.push(next.status);
    return next;
  }
}

describe("upload y procesamiento documental", () => {
  it("acepta y procesa un TXT válido hasta review", async () => {
    const upload = await validateKnowledgeUpload(
      uploadFile("negocio.txt", "text/plain", Buffer.from("Línea 1\r\n\r\nLínea 2"))
    );
    const store = new MemoryStore(documentRow("org_a", upload.mimeType));
    const result = await processKnowledgeDocumentWithStore(
      store,
      "org_a",
      "kbd_1",
      upload.bytes
    );

    expect(result.status).toBe("review");
    expect(store.states).toEqual(["uploaded", "processing", "review"]);
    expect(store.chunks.get("org_a:kbd_1")?.[0]?.content).toBe(
      "Línea 1\n\nLínea 2"
    );
  });

  it("acepta y extrae un PDF válido", async () => {
    const bytes = makePdf("Servicio premium disponible");
    const upload = await validateKnowledgeUpload(
      uploadFile("servicios.pdf", "application/pdf", bytes)
    );
    const store = new MemoryStore(documentRow("org_a", upload.mimeType));
    const result = await processKnowledgeDocumentWithStore(
      store,
      "org_a",
      "kbd_1",
      upload.bytes
    );

    expect(result.status).toBe("review");
    expect(store.chunks.get("org_a:kbd_1")?.[0]).toMatchObject({
      content: "Servicio premium disponible",
      page: 1,
      approved: false,
    });
  });

  it("rechaza MIME inválido", async () => {
    await expect(
      validateKnowledgeUpload(
        uploadFile("datos.txt", "application/octet-stream", Buffer.from("texto"))
      )
    ).rejects.toMatchObject({ code: "unsupported_mime", status: 415 });
  });

  it("rechaza extensión inválida", async () => {
    await expect(
      validateKnowledgeUpload(
        uploadFile("datos.docx", "text/plain", Buffer.from("texto"))
      )
    ).rejects.toMatchObject({ code: "unsupported_extension", status: 415 });
  });

  it("rechaza archivo vacío", async () => {
    await expect(
      validateKnowledgeUpload(uploadFile("datos.txt", "text/plain", Buffer.alloc(0)))
    ).rejects.toMatchObject({ code: "empty_file", status: 422 });
  });

  it("rechaza archivos mayores a 10 MB antes de leerlos", async () => {
    let read = false;
    const file: KnowledgeUploadFile = {
      name: "datos.txt",
      type: "text/plain",
      size: MAX_KNOWLEDGE_FILE_BYTES + 1,
      arrayBuffer: async () => {
        read = true;
        return new ArrayBuffer(0);
      },
    };
    await expect(validateKnowledgeUpload(file)).rejects.toMatchObject({
      code: "file_too_large",
      status: 413,
    });
    expect(read).toBe(false);
  });

  it.each(["../datos.txt", "carpeta/datos.txt", "carpeta\\datos.txt"])(
    "rechaza path traversal en %s",
    async (name) => {
      await expect(
        validateKnowledgeUpload(uploadFile(name, "text/plain", Buffer.from("texto")))
      ).rejects.toBeInstanceOf(KnowledgeUploadError);
    }
  );

  it("tenant A no puede procesar un documento de B", async () => {
    const store = new MemoryStore(documentRow("org_b", "text/plain"));
    await expect(
      processKnowledgeDocumentWithStore(
        store,
        "org_a",
        "kbd_1",
        Buffer.from("texto")
      )
    ).rejects.toBeInstanceOf(KnowledgeDocumentNotFoundError);
    expect(store.states).toEqual(["uploaded"]);
  });

  it("TXT largo genera chunks deterministas no aprobados", async () => {
    const text = Array.from(
      { length: 80 },
      (_, index) => `Párrafo ${index + 1}. Información comercial verificable para el agente.`
    ).join("\n\n");
    const store = new MemoryStore(documentRow("org_a", "text/plain"));
    await processKnowledgeDocumentWithStore(
      store,
      "org_a",
      "kbd_1",
      Buffer.from(text)
    );
    const chunks = store.chunks.get("org_a:kbd_1") ?? [];

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.position)).toEqual(
      chunks.map((_, index) => index)
    );
    expect(chunks.every((chunk) => chunk.approved === false)).toBe(true);
    expect(chunks.every((chunk) => chunk.content.length <= 1_800)).toBe(true);
  });

  it("PDF sin texto queda failed con mensaje claro", async () => {
    const bytes = makePdf();
    const store = new MemoryStore(documentRow("org_a", "application/pdf"));
    const result = await processKnowledgeDocumentWithStore(
      store,
      "org_a",
      "kbd_1",
      bytes
    );

    expect(result).toMatchObject({ status: "failed", error: PDF_NO_TEXT_MESSAGE });
    expect(store.chunks.has("org_a:kbd_1")).toBe(false);
  });

  it("un fallo de extracción elimina chunks anteriores", async () => {
    const store = new MemoryStore(documentRow("org_a", "text/plain"));
    store.chunks.set("org_a:kbd_1", [
      { content: "anterior", position: 0, page: null, approved: false },
    ]);
    const result = await processKnowledgeDocumentWithStore(
      store,
      "org_a",
      "kbd_1",
      Buffer.from("texto"),
      async () => {
        throw new Error("contenido sensible que no debe persistirse");
      }
    );

    expect(result).toMatchObject({
      status: "failed",
      error: "No se pudo extraer el contenido del documento.",
    });
    expect(store.chunks.has("org_a:kbd_1")).toBe(false);
    expect(result.error).not.toContain("sensible");
  });

  it("la implementación productiva aplica RBAC y scoping del tenant", () => {
    const route = readFileSync(
      resolve(process.cwd(), "src/app/api/kb/documents/route.ts"),
      "utf8"
    );
    const processing = readFileSync(
      resolve(process.cwd(), "src/server/kb/documents/processing.ts"),
      "utf8"
    );
    expect(route).toContain('["owner", "admin"]');
    expect(route).toContain("session.organizationId");
    expect(processing).toContain("schema.kbDocument.organizationId");
    expect(processing).toContain("schema.kbDocumentChunk.organizationId");
    expect(processing).toContain("getDb().transaction");
  });
});
