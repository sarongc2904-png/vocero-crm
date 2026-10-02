import { beforeEach, describe, expect, it, vi } from "vitest";

const retrieveRelevantDocumentChunks = vi.fn();

vi.mock("@/server/kb/documents/retrieval", () => ({
  retrieveRelevantDocumentChunks: (...args: unknown[]) =>
    retrieveRelevantDocumentChunks(...args),
}));

import { buildJudgeKnowledgeText } from "@/server/lab/runner";

describe("conocimiento documental del juez del Lab", () => {
  beforeEach(() => {
    retrieveRelevantDocumentChunks.mockReset();
  });

  it("incluye chunks aprobados recuperados para el mismo tenant", async () => {
    retrieveRelevantDocumentChunks
      .mockResolvedValueOnce([
        {
          id: "chunk-precios",
          documentId: "doc-dental",
          content:
            "Limpieza dental: $700 MXN. Brackets metálicos: desde $8,000 MXN.",
          position: 0,
          page: null,
          score: 10,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "chunk-precios",
          documentId: "doc-dental",
          content:
            "Limpieza dental: $700 MXN. Brackets metálicos: desde $8,000 MXN.",
          position: 0,
          page: null,
          score: 8,
        },
      ]);

    const result = await buildJudgeKnowledgeText({
      organizationId: "org_dental",
      baseKbText: "KB tradicional",
      transcript: [
        { role: "cliente", text: "¿Cuánto cuesta?" },
        {
          role: "agente",
          text: "La limpieza cuesta $700 MXN.",
        },
        { role: "cliente", text: "¿Y los brackets?" },
      ],
    });

    expect(result).toContain("KB tradicional");
    expect(result).toContain("Limpieza dental: $700 MXN");
    expect(result).toContain("Brackets metálicos: desde $8,000 MXN");

    // El mismo chunk recuperado en varios turnos no debe duplicarse.
    expect(result.match(/Limpieza dental: \$700 MXN/g)).toHaveLength(1);

    expect(retrieveRelevantDocumentChunks).toHaveBeenCalledTimes(2);

    expect(retrieveRelevantDocumentChunks).toHaveBeenNthCalledWith(1, {
      organizationId: "org_dental",
      query: "¿Cuánto cuesta?",
      maxChunks: 5,
      maxCharacters: 7_500,
    });

    expect(retrieveRelevantDocumentChunks).toHaveBeenNthCalledWith(2, {
      organizationId: "org_dental",
      query: "¿Y los brackets?",
      maxChunks: 5,
      maxCharacters: 7_500,
    });
  });

  it("no consulta retrieval usando mensajes del agente", async () => {
    retrieveRelevantDocumentChunks.mockResolvedValue([]);

    await buildJudgeKnowledgeText({
      organizationId: "org_1",
      baseKbText: "",
      transcript: [
        { role: "agente", text: "La limpieza cuesta $700 MXN." },
      ],
    });

    expect(retrieveRelevantDocumentChunks).not.toHaveBeenCalled();
  });
});
