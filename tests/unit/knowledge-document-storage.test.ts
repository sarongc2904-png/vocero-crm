import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteKnowledgeFile,
  knowledgeStoragePath,
  resolveKnowledgeStoragePath,
  saveKnowledgeFile,
} from "@/server/kb/documents/storage";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("almacenamiento de documentos de conocimiento", () => {
  it("crea una ruta relativa sin usar el nombre original", () => {
    expect(knowledgeStoragePath("org_a", "doc_123", ".pdf")).toBe("org_a/doc_123.pdf");
  });

  it.each([
    ["../org_b", "doc_1", ".txt"],
    ["org_a", "../doc_1", ".txt"],
    ["org_a", "doc_1", ".exe"],
  ])("rechaza segmentos o formatos inseguros", (org, document, extension) => {
    expect(() => knowledgeStoragePath(org, document, extension as ".txt")).toThrow();
  });

  it("rechaza una ruta de otro tenant y traversal", () => {
    expect(() =>
      resolveKnowledgeStoragePath("C:/data/knowledge", "org_a", "org_b/doc_1.txt")
    ).toThrow(/organización/);
    expect(() =>
      resolveKnowledgeStoragePath("C:/data/knowledge", "org_a", "org_a/../doc_1.txt")
    ).toThrow(/inválida/);
  });

  it("guarda sin sobrescribir y elimina solo dentro del tenant", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vocero-knowledge-"));
    tempRoots.push(root);
    const previous = process.env.KNOWLEDGE_DIR;
    process.env.KNOWLEDGE_DIR = root;
    process.env.APP_BASE_URL ??= "http://localhost:3000";
    process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
    process.env.BETTER_AUTH_SECRET ??= "secret-de-test-suficiente";
    process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 4).toString("base64");
    process.env.META_WEBHOOK_VERIFY_TOKEN ??= "verify-token-test";

    try {
      const stored = await saveKnowledgeFile("org_a", "doc_1", ".txt", Buffer.from("contenido"));
      const absolute = resolveKnowledgeStoragePath(root, "org_a", stored);
      expect(await readFile(absolute, "utf8")).toBe("contenido");
      await expect(
        saveKnowledgeFile("org_a", "doc_1", ".txt", Buffer.from("otro"))
      ).rejects.toMatchObject({ code: "EEXIST" });
      await expect(deleteKnowledgeFile("org_b", stored)).rejects.toThrow(/organización/);
      await expect(deleteKnowledgeFile("org_a", stored)).resolves.toBe(true);
      await expect(deleteKnowledgeFile("org_a", stored)).resolves.toBe(false);
    } finally {
      if (previous === undefined) delete process.env.KNOWLEDGE_DIR;
      else process.env.KNOWLEDGE_DIR = previous;
    }
  });
});
