import { extractText } from "unpdf";
import { normalizeDocumentText } from "./chunking";
import type { KnowledgeMimeType } from "./validation";

export const PDF_NO_TEXT_MESSAGE =
  "Este PDF no contiene texto extraíble. Usa un PDF con texto seleccionable.";

export type ExtractedDocumentPage = {
  content: string;
  page: number | null;
};

export class DocumentExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentExtractionError";
  }
}

export async function extractDocumentPages(
  mimeType: KnowledgeMimeType,
  bytes: Buffer
): Promise<ExtractedDocumentPage[]> {
  if (mimeType === "text/plain") {
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new DocumentExtractionError("El archivo TXT no es UTF-8 válido.");
    }
    const content = normalizeDocumentText(decoded);
    if (!content) {
      throw new DocumentExtractionError("El archivo TXT no contiene texto.");
    }
    return [{ content, page: null }];
  }

  try {
    const result = await extractText(Uint8Array.from(bytes), {
      mergePages: false,
    });
    const pages = (Array.isArray(result.text) ? result.text : [result.text])
      .map((content, index) => ({
        content: normalizeDocumentText(content),
        page: index + 1,
      }))
      .filter((page) => page.content.length > 0);
    if (pages.length === 0) throw new DocumentExtractionError(PDF_NO_TEXT_MESSAGE);
    return pages;
  } catch (error) {
    if (error instanceof DocumentExtractionError) throw error;
    throw new DocumentExtractionError(
      "No se pudo extraer texto de este PDF. Verifica que el archivo sea válido."
    );
  }
}
