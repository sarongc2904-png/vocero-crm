import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("schema documental multi-tenant", () => {
  const schema = readFileSync(resolve(process.cwd(), "src/lib/db/schema.ts"), "utf8");

  it("define documentos y chunks con organizationId obligatorio", () => {
    for (const table of ["kbDocument", "kbDocumentChunk"]) {
      const start = schema.indexOf(`export const ${table}`);
      expect(start).toBeGreaterThan(-1);
      const body = schema.slice(start, schema.indexOf("\n);", start) + 3);
      expect(body).toContain('organizationId: text("organization_id")');
      expect(body).toContain(".notNull()");
    }
  });

  it("impide asociar un chunk con un documento de otro tenant", () => {
    expect(schema).toContain("kb_document_chunk_org_document_fk");
    expect(schema).toContain("columns: [t.organizationId, t.documentId]");
    expect(schema).toContain("foreignColumns: [kbDocument.organizationId, kbDocument.id]");
  });

  it("mantiene desactivados los chunks hasta revisión", () => {
    const start = schema.indexOf("export const kbDocumentChunk");
    const body = schema.slice(start, schema.indexOf("\n);", start) + 3);
    expect(body).toContain('approved: boolean("approved").notNull().default(false)');
  });
});
