import path from "node:path";
import type { KnowledgeExtension } from "./storage";

export const MAX_KNOWLEDGE_FILE_BYTES = 10 * 1024 * 1024;

const FORMAT_BY_EXTENSION = {
  ".txt": "text/plain",
  ".pdf": "application/pdf",
} as const;

export type KnowledgeMimeType = (typeof FORMAT_BY_EXTENSION)[KnowledgeExtension];

export type KnowledgeUploadFile = Pick<
  File,
  "name" | "type" | "size" | "arrayBuffer"
>;

export type ValidatedKnowledgeUpload = {
  filename: string;
  mimeType: KnowledgeMimeType;
  extension: KnowledgeExtension;
  bytes: Buffer;
};

export class KnowledgeUploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "KnowledgeUploadError";
  }
}

export async function validateKnowledgeUpload(
  file: KnowledgeUploadFile
): Promise<ValidatedKnowledgeUpload> {
  const filename = file.name.trim();
  if (
    !filename ||
    filename.length > 255 ||
    filename === "." ||
    filename === ".." ||
    /[/\\\0]/.test(filename)
  ) {
    throw new KnowledgeUploadError(
      422,
      "invalid_filename",
      "El nombre del archivo no es válido"
    );
  }

  const extension = path.extname(filename).toLowerCase();
  if (!(extension in FORMAT_BY_EXTENSION)) {
    throw new KnowledgeUploadError(
      415,
      "unsupported_extension",
      "Solo se permiten archivos TXT y PDF"
    );
  }

  const expectedMime = FORMAT_BY_EXTENSION[extension as KnowledgeExtension];
  if (file.type !== expectedMime) {
    throw new KnowledgeUploadError(
      415,
      "unsupported_mime",
      "El tipo MIME no coincide con la extensión del archivo"
    );
  }
  if (file.size <= 0) {
    throw new KnowledgeUploadError(
      422,
      "empty_file",
      "El archivo está vacío"
    );
  }
  if (file.size > MAX_KNOWLEDGE_FILE_BYTES) {
    throw new KnowledgeUploadError(
      413,
      "file_too_large",
      "El archivo excede el límite de 10 MB"
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0) {
    throw new KnowledgeUploadError(422, "empty_file", "El archivo está vacío");
  }
  if (bytes.length > MAX_KNOWLEDGE_FILE_BYTES) {
    throw new KnowledgeUploadError(
      413,
      "file_too_large",
      "El archivo excede el límite de 10 MB"
    );
  }
  if (extension === ".pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new KnowledgeUploadError(
      422,
      "invalid_pdf",
      "El archivo no tiene una cabecera PDF válida"
    );
  }

  return {
    filename,
    mimeType: expectedMime,
    extension: extension as KnowledgeExtension,
    bytes,
  };
}
