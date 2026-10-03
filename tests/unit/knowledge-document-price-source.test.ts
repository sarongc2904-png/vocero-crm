import { describe, expect, it, vi } from "vitest";
import { chunkDocumentText } from "@/server/kb/documents/chunking";
import {
  buildCompletePriceSource,
  type ManualPriceSourceEntry,
} from "@/server/kb/documents/price-source";
import {
  loadCompleteApprovedDocumentChunksWithStore,
  type CompleteDocumentChunkRow,
  type CompleteDocumentSourceStore,
} from "@/server/kb/documents/retrieval";

const PRICE_LINES = [
  "- Consulta de valoración: $300 MXN",
  "- Limpieza dental: $700 MXN",
  "- Resina dental: desde $800 MXN por pieza",
  "- Blanqueamiento dental: desde $2,500 MXN",
  "- Extracción simple: desde $900 MXN",
  "- Extracción de muela del juicio: desde $2,500 MXN",
  "- Ortodoncia: valoración inicial $500 MXN",
  "- Brackets metálicos: desde $8,000 MXN",
  "- Endodoncia: desde $3,000 MXN",
  "- Corona dental: desde $4,500 MXN",
] as const;

const DEMO_DOCUMENT = [
  "CLÍNICA DENTAL SONRISA PLUS",
  "2. SERVICIOS Y PRECIOS DE REFERENCIA",
  ...PRICE_LINES,
  "Los precios son de referencia y pueden cambiar después de la valoración clínica.",
].join("\n");

function rowsFromText(
  text: string,
  documentId = "doc_demo",
  organizationId = "org_a"
): CompleteDocumentChunkRow[] {
  return chunkDocumentText(text).map((chunk, index) => ({
    id: `chunk_${documentId}_${index}`,
    organizationId,
    documentId,
    documentStatus: "ready",
    content: chunk.content,
    position: chunk.position,
    page: chunk.page,
    approved: true,
  }));
}

function store(
  rows: CompleteDocumentChunkRow[],
  documentCount = new Set(rows.map((row) => row.documentId)).size
) {
  const calls: string[] = [];
  const loadPreflight = vi.fn(async () => {
    calls.push("preflight");
    return {
      documentCount,
      chunkCount: rows.filter((row) => row.id !== null).length,
      totalCharacters: rows.reduce((total, row) => total + (row.content?.length ?? 0), 0),
    };
  });
  const loadRows = vi.fn(async () => {
    calls.push("rows");
    return rows;
  });
  return {
    calls,
    loadPreflight,
    loadRows,
    value: { loadPreflight, loadRows } satisfies CompleteDocumentSourceStore,
  };
}

describe("fuente completa DB-only", () => {
  it("hace el preflight agregado antes de traer una sola vez todos los chunks", async () => {
    const fake = store(rowsFromText(DEMO_DOCUMENT));
    const result = await loadCompleteApprovedDocumentChunksWithStore(fake.value, {
      organizationId: "org_a",
    });

    expect(fake.calls).toEqual(["preflight", "rows"]);
    expect(fake.loadPreflight).toHaveBeenCalledWith("org_a");
    expect(fake.loadRows).toHaveBeenCalledWith("org_a");
    expect(result.complete).toBe(true);
  });

  it("rechaza filas de otra organización aunque el store las entregue", async () => {
    const rows = [
      ...rowsFromText(DEMO_DOCUMENT, "doc_a", "org_a"),
      ...rowsFromText(DEMO_DOCUMENT, "doc_b", "org_b"),
    ];
    const fake = store(rows, 2);
    const result = await loadCompleteApprovedDocumentChunksWithStore(fake.value, {
      organizationId: "org_a",
    });

    expect(result).toMatchObject({
      complete: false,
      reason: "tenant_mismatch",
      documentId: "doc_b",
    });
  });

  it.each([
    ["posición ausente", [0, 2], "position_gap"],
    ["posición duplicada", [0, 0], "position_duplicate"],
  ])("%s invalida el documento completo", async (_label, positions, reason) => {
    const rows = rowsFromText(`${"x".repeat(1_900)}\n${DEMO_DOCUMENT}`)
      .slice(0, 2)
      .map((row, index) => ({
        ...row,
        position: positions[index]!,
      }));
    const result = await loadCompleteApprovedDocumentChunksWithStore(store(rows).value, {
      organizationId: "org_a",
    });
    expect(result).toMatchObject({ complete: false, reason, documentId: "doc_demo" });
  });

  it("un chunk no aprobado invalida todo", async () => {
    const rows = rowsFromText(DEMO_DOCUMENT);
    rows[0] = { ...rows[0]!, approved: false };
    const result = await loadCompleteApprovedDocumentChunksWithStore(store(rows).value, {
      organizationId: "org_a",
    });
    expect(result).toMatchObject({
      complete: false,
      reason: "chunk_not_approved",
      documentId: "doc_demo",
    });
  });

  it("un documento ready sin chunks invalida todo", async () => {
    const missing: CompleteDocumentChunkRow = {
      id: null,
      organizationId: "org_a",
      documentId: "doc_empty",
      documentStatus: "ready",
      content: null,
      position: null,
      page: null,
      approved: null,
    };
    const result = await loadCompleteApprovedDocumentChunksWithStore(store([missing], 1).value, {
      organizationId: "org_a",
    });
    expect(result).toMatchObject({
      complete: false,
      reason: "missing_chunks",
      documentId: "doc_empty",
    });
  });

  it("el preflight excedido respalda sin ejecutar la consulta de contenido", async () => {
    const fake = store(rowsFromText(DEMO_DOCUMENT));
    fake.loadPreflight.mockResolvedValue({
      documentCount: 1,
      chunkCount: 2_001,
      totalCharacters: 100,
    });
    const result = await loadCompleteApprovedDocumentChunksWithStore(fake.value, {
      organizationId: "org_a",
    });
    expect(result).toMatchObject({ complete: false, reason: "corpus_limit" });
    expect(fake.loadRows).not.toHaveBeenCalled();
  });
});

describe("extracción comercial completa", () => {
  it("barre cortes reales de 0 a 2,000: diez líneas exactas o respaldo, nunca parcial", () => {
    for (let padding = 0; padding <= 2_000; padding += 17) {
      const rows = rowsFromText(`${"x".repeat(padding)}\n${DEMO_DOCUMENT}`);
      const result = buildCompletePriceSource({
        organizationId: "org_a",
        manualEntries: [],
        documentChunks: rows.map((row) => ({ ...row, id: row.id! })) as never,
      });
      if (result.complete) {
        expect(result.lines, `padding=${padding}`).toEqual(PRICE_LINES);
      } else {
        expect(result.lines, `padding=${padding}`).toEqual([]);
      }
      for (const line of result.lines) {
        expect(PRICE_LINES, `padding=${padding}; line=${line}`).toContain(line as never);
      }
    }
  });

  it("línea corta en el borde conserva solo su copia completa", () => {
    const line = "- Servicio corto: $1,234 MXN con confirmación en valoración.";
    const result = buildCompletePriceSource({
      organizationId: "org_a",
      manualEntries: [],
      documentChunks: rowsFromText(`${"x".repeat(1_750)}\n${line}\nFIN`) as never,
    });
    expect(result).toEqual(expect.objectContaining({ complete: true, lines: [line] }));
  });

  it("línea mayor a 200 partida sin copia completa obliga respaldo", () => {
    const line = `- Servicio extraordinariamente detallado: $9,999 MXN ${"descripción ".repeat(28)}fin.`;
    const result = buildCompletePriceSource({
      organizationId: "org_a",
      manualEntries: [],
      documentChunks: rowsFromText(`${"x".repeat(1_590)}\n${line}\nFIN`) as never,
    });
    expect(line.length).toBeGreaterThan(200);
    expect(result).toMatchObject({ complete: false, lines: [], reason: "truncated_price_line" });
  });

  it("reúne precios ubicados en chunks separados del mismo documento", () => {
    const source = `${PRICE_LINES[0]}\n${"x".repeat(1_850)}\n${PRICE_LINES[1]}`;
    const chunks = rowsFromText(source);
    expect(chunks.length).toBeGreaterThan(1);
    const result = buildCompletePriceSource({
      organizationId: "org_a",
      manualEntries: [],
      documentChunks: chunks as never,
    });
    expect(result).toEqual(
      expect.objectContaining({ complete: true, lines: PRICE_LINES.slice(0, 2) })
    );
  });

  it("incluye y deduplica todas las entradas manuales cuando no hay documentos", () => {
    const manualEntries: ManualPriceSourceEntry[] = [
      { id: "kb_1", text: PRICE_LINES[0] },
      { id: "kb_2", text: `  ${PRICE_LINES[0]}  ` },
      { id: "kb_3", text: PRICE_LINES[1] },
    ];
    expect(
      buildCompletePriceSource({ organizationId: "org_a", manualEntries, documentChunks: [] })
    ).toEqual(expect.objectContaining({ complete: true, lines: PRICE_LINES.slice(0, 2) }));
  });

  it("precios contradictorios entre manual y documento obligan respaldo", () => {
    const manualEntries: ManualPriceSourceEntry[] = [
      { id: "kb_1", text: "- Limpieza dental: $900 MXN" },
    ];
    const result = buildCompletePriceSource({
      organizationId: "org_a",
      manualEntries,
      documentChunks: rowsFromText("- Limpieza dental: $700 MXN") as never,
    });
    expect(result).toMatchObject({
      complete: false,
      lines: [],
      reason: "conflicting_price",
    });
  });
});
