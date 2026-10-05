import { describe, expect, it, vi } from "vitest";
import { chunkDocumentText } from "@/server/kb/documents/chunking";
import {
  buildCompletePriceSource,
  extractPriceLinesFromText,
  type ManualPriceSourceEntry,
} from "@/server/kb/documents/price-source";
import { groundedConversationReply } from "@/server/ai/prompts";
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

const DEMO_NARRATIVE_PRICE_LINE =
  "Respuesta: La limpieza dental tiene un precio de referencia de $700 MXN. Si durante la valoración se requiere un procedimiento adicional, el dentista se lo explicará antes de realizarlo.";

function unmarkedPriceLine(length: number): string {
  const suffix = " $700 MXN";
  return `${"x".repeat(length - suffix.length)}${suffix}`;
}

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
  const malformedMixedPriceList = [
    "- Limpieza facial: $700 MXN",
    "- Peeling $900 MXN",
    "- Botox: $3,500 MXN",
  ].join("\n");

  it.each([
    ["pesos", "- Limpieza facial: 700 pesos"],
    ["MXN", "- Limpieza facial: 700 MXN"],
    ["MN", "- Limpieza facial: 700 MN"],
    ["tabla", "| Limpieza facial | $700 MXN |"],
    ["sin marcador", "Peeling $900 MXN"],
    ["frase corta", "Todo desde $700 MXN"],
  ])("apariencia de precio %s no aceptada obliga respaldo", (_label, text) => {
    const result = buildCompletePriceSource({
      organizationId: "org_a",
      manualEntries: [{ id: "kb_price", text }],
      documentChunks: [],
    });
    expect(result).toMatchObject({
      complete: false,
      lines: [],
      reason: "malformed_price_line",
    });
  });

  it.each([
    ["guion", `- ${"x".repeat(130)} $700 MXN`],
    ["viñeta", `• ${"x".repeat(130)} $700 MXN`],
    ["asterisco", `* ${"x".repeat(130)} $700 MXN`],
    ["numeración", `1. ${"x".repeat(130)} $700 MXN`],
    ["numeración con paréntesis", `2) ${"x".repeat(130)} $700 MXN`],
    ["tabla larga", `| ${"x".repeat(130)} | $700 MXN |`],
  ])("la forma de lista %s invalida aunque la línea sea larga", (_label, text) => {
    expect(
      buildCompletePriceSource({
        organizationId: "org_a",
        manualEntries: [{ id: "kb_shaped_price", text }],
        documentChunks: [],
      })
    ).toMatchObject({ complete: false, lines: [], reason: "malformed_price_line" });
  });

  it("aplica el umbral a ambos lados: corta sin viñeta respalda, larga con precio final se reconoce", () => {
    const below = unmarkedPriceLine(59);
    const above = unmarkedPriceLine(61);
    expect(below).toHaveLength(59);
    expect(above).toHaveLength(61);
    expect(
      buildCompletePriceSource({
        organizationId: "org_a",
        manualEntries: [{ id: "kb_below", text: below }],
        documentChunks: [],
      })
    ).toMatchObject({ complete: false, reason: "malformed_price_line" });
    expect(
      buildCompletePriceSource({
        organizationId: "org_a",
        manualEntries: [{ id: "kb_above", text: above }],
        documentChunks: [],
      })
    ).toEqual({ complete: true, lines: [above] });
  });

  describe("4b: línea larga sin viñeta con el precio al final", () => {
    const LONG_UNMARKED = [
      "Limpieza dental profunda con ultrasonido, pulido y revisión general $700 MXN",
      "Paquete de tres sesiones de blanqueamiento con férula personalizada: $2,500 MXN",
      "Consulta de valoración con radiografía panorámica incluida en la visita $ 450",
      "Guarda oclusal rígida hecha a la medida en laboratorio externo $1,800.00 pesos",
    ] as const;

    it.each(LONG_UNMARKED)("se reconoce como precio: %s", (line) => {
      expect(line.length).toBeGreaterThan(60);
      expect(
        buildCompletePriceSource({
          organizationId: "org_a",
          manualEntries: [{ id: "kb_long", text: line }],
          documentChunks: [],
        })
      ).toEqual({ complete: true, lines: [line] });
      expect(extractPriceLinesFromText(line)).toEqual({ complete: true, lines: [line] });
    });

    it("se reconoce dentro de un documento junto a los diez precios del demo", () => {
      const line = LONG_UNMARKED[0];
      const result = buildCompletePriceSource({
        organizationId: "org_a",
        manualEntries: [],
        documentChunks: rowsFromText(`${DEMO_DOCUMENT}\n${line}`) as never,
      });
      expect(result).toEqual({ complete: true, lines: [...PRICE_LINES, line] });
    });

    it.each([
      [
        "punto final",
        "Limpieza dental profunda con ultrasonido, pulido y revisión general $700 MXN.",
      ],
      [
        "precio a media línea",
        "Limpieza dental profunda con ultrasonido por $700 MXN y revisión general incluida",
      ],
      [
        "dos montos",
        "Limpieza dental profunda con ultrasonido y pulido general de $500 a $700 MXN",
      ],
      [
        "monto sin signo de pesos",
        "Limpieza dental profunda con ultrasonido, pulido y revisión general 700 pesos",
      ],
      [
        "pregunta",
        "¿Sabía que la limpieza dental profunda con ultrasonido y pulido cuesta $700 MXN?",
      ],
      ["sin servicio antes del monto", `${".".repeat(60)} $700 MXN`],
    ])("ambigua (%s) se ignora: no se adivina el precio", (_label, line) => {
      expect(line.trim().length).toBeGreaterThan(60);
      expect(
        buildCompletePriceSource({
          organizationId: "org_a",
          manualEntries: [{ id: "kb_ambiguous", text: line }],
          documentChunks: [],
        })
      ).toMatchObject({ complete: false, lines: [], reason: "no_price_lines" });
    });

    it("barre cortes reales con la línea larga: once líneas exactas o respaldo, nunca parcial", () => {
      const line = LONG_UNMARKED[1];
      const expected = [...PRICE_LINES, line];
      for (let padding = 0; padding <= 2_000; padding += 13) {
        const rows = rowsFromText(`${"x".repeat(padding)}\n${DEMO_DOCUMENT}\n${line}\nFIN`);
        const result = buildCompletePriceSource({
          organizationId: "org_a",
          manualEntries: [],
          documentChunks: rows as never,
        });
        if (result.complete) {
          expect(result.lines, `padding=${padding}`).toEqual(expected);
        } else {
          expect(result.lines, `padding=${padding}`).toEqual([]);
        }
      }
    });

    it("partida en el borde sin copia completa obliga respaldo", () => {
      const line = `Servicio extraordinariamente detallado ${"descripción ".repeat(28)}con todo $9,999 MXN`;
      expect(line.length).toBeGreaterThan(200);
      const result = buildCompletePriceSource({
        organizationId: "org_a",
        manualEntries: [],
        documentChunks: rowsFromText(`${"x".repeat(1_590)}\n${line}\nFIN`) as never,
      });
      expect(result).toMatchObject({ complete: false, lines: [], reason: "truncated_price_line" });
    });
  });

  it("ignora la línea narrativa larga y conserva los diez precios estrictos del demo", () => {
    expect(DEMO_NARRATIVE_PRICE_LINE).toHaveLength(186);
    expect(extractPriceLinesFromText(`${DEMO_DOCUMENT}\n${DEMO_NARRATIVE_PRICE_LINE}`)).toEqual({
      complete: true,
      lines: PRICE_LINES,
    });
  });

  it.each([
    "Horario: 10 a 14 hrs",
    "Tel 8671234567",
    "Duración 30 minutos",
    "Cita con 2 horas de aviso",
  ])("%s no se confunde con una línea de precio", (text) => {
    expect(
      buildCompletePriceSource({
        organizationId: "org_a",
        manualEntries: [{ id: "kb_information", text }],
        documentChunks: [],
      })
    ).toMatchObject({ complete: false, lines: [], reason: "no_price_lines" });
  });

  it("un precio malformado dentro de un documento invalida toda la fuente", () => {
    const result = buildCompletePriceSource({
      organizationId: "org_a",
      manualEntries: [],
      documentChunks: rowsFromText(malformedMixedPriceList) as never,
    });
    expect(result).toMatchObject({
      complete: false,
      lines: [],
      reason: "malformed_price_line",
    });
  });

  it("una fuente documental malformada deja la pregunta en manos del modelo", () => {
    const completePriceSource = buildCompletePriceSource({
      organizationId: "org_a",
      manualEntries: [],
      documentChunks: rowsFromText(malformedMixedPriceList) as never,
    });
    expect(
      groundedConversationReply({
        inboundText: "¿Cuánto cuesta cada servicio y qué incluye?",
        customerHistoryText: "",
        knowledgeText: malformedMixedPriceList,
        completePriceSource,
      })
    ).toBeNull();
  });

  it("el mismo precio malformado en una entrada manual invalida toda la fuente", () => {
    expect(
      buildCompletePriceSource({
        organizationId: "org_a",
        manualEntries: [{ id: "kb_malformed", text: malformedMixedPriceList }],
        documentChunks: [],
      })
    ).toMatchObject({ complete: false, lines: [], reason: "malformed_price_line" });
  });

  it("deduplica líneas iguales aunque las entradas manuales completas sean distintas", () => {
    const shared = "- Consulta de valoración: $300 MXN";
    expect(
      buildCompletePriceSource({
        organizationId: "org_a",
        manualEntries: [
          { id: "kb_1", text: `Nota uno\n${shared}` },
          { id: "kb_2", text: `Nota dos\n${shared}` },
        ],
        documentChunks: [],
      })
    ).toEqual({ complete: true, lines: [shared] });
  });

  it("el documento demo conserva sus diez precios y ninguna línea malformada", () => {
    expect(extractPriceLinesFromText(DEMO_DOCUMENT)).toEqual({
      complete: true,
      lines: PRICE_LINES,
    });
  });

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

describe("4b no contamina los nombres de servicio del agente", () => {
  it("una línea larga sin viñeta no aporta palabras sueltas como 'servicio mencionado'", () => {
    const knowledgeText = [
      "- Limpieza dental: $700 MXN",
      "Paquete de seguimiento general con tres revisiones semestrales incluidas $1,500 MXN",
      "Para agendar una cita solicitar:",
      "- Nombre completo",
      "- Número de teléfono",
      "- Servicio o motivo de consulta",
    ].join("\n");
    expect(
      groundedConversationReply({
        inboundText: "quiero avanzar hoy",
        customerHistoryText: "me llamo Ana Pérez, mi teléfono es 8671234567, busco algo general",
        knowledgeText,
      })
    ).toMatch(/servicio o motivo/i);
  });
});
