import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { documentDto } from "@/server/kb/documents/lifecycle";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("revisión y aprobación de documentos", () => {
  it("no expone organizationId ni storagePath en la API", () => {
    const dto = documentDto({
      id: "kbd_1",
      organizationId: "org_a",
      filename: "servicios.pdf",
      mimeType: "application/pdf",
      fileSize: 1200,
      storagePath: "org_a/kbd_1.pdf",
      status: "review",
      error: null,
      createdAt: new Date("2026-10-01T00:00:00Z"),
      updatedAt: new Date("2026-10-01T00:00:00Z"),
    });

    expect(dto).not.toHaveProperty("organizationId");
    expect(dto).not.toHaveProperty("storagePath");
    expect(dto).toMatchObject({ id: "kbd_1", status: "review" });
  });

  it("protege list/get/delete/approve con owner-admin y tenant activo", () => {
    const collection = source("src/app/api/kb/documents/route.ts");
    const detail = source("src/app/api/kb/documents/[id]/route.ts");
    const approve = source("src/app/api/kb/documents/[id]/approve/route.ts");

    for (const route of [collection, detail, approve]) {
      expect(route).toContain('["owner", "admin"]');
      expect(route).toContain("session.organizationId");
    }
    expect(detail).toContain("knowledge.document.delete");
    expect(approve).toContain("knowledge.document.approve");
  });

  it("aprueba chunks y documento dentro de una transacción", () => {
    const lifecycle = source("src/server/kb/documents/lifecycle.ts");

    expect(lifecycle).toContain("getDb().transaction");
    expect(lifecycle).toContain(".set({ approved: true })");
    expect(lifecycle).toContain('status: "ready"');
    expect(lifecycle).toContain('document.status !== "review"');
    expect(lifecycle).toContain("schema.kbDocumentChunk.organizationId");
    expect(lifecycle).toContain("schema.kbDocument.organizationId");
  });

  it("elimina archivo, chunks y documento con alcance tenant", () => {
    const lifecycle = source("src/server/kb/documents/lifecycle.ts");

    expect(lifecycle).toContain("deleteKnowledgeFile(organizationId, document.storagePath)");
    expect(lifecycle).toContain(".delete(schema.kbDocumentChunk)");
    expect(lifecycle).toContain(".delete(schema.kbDocument)");
    expect(lifecycle.match(/scoped\(/g)?.length).toBeGreaterThanOrEqual(8);
  });

  it("muestra upload, estados, revisión, aprobación y borrado sin autoaprobar", () => {
    const ui = source("src/components/agent/agent-client.tsx");

    for (const label of [
      "Documentos",
      "Procesando",
      "Revisión pendiente",
      "Activo",
      "Error",
      "Subir documento",
      "Revisar",
      "Aprobar y activar",
    ]) {
      expect(ui).toContain(label);
    }
    expect(ui).toContain('fetch("/api/kb/documents"');
    expect(ui).toContain("/approve");
    expect(ui).toContain('method: "DELETE"');
    expect(ui.indexOf("Aprobar y activar")).toBeGreaterThan(
      ui.indexOf("reviewing.document.status")
    );
  });
});
