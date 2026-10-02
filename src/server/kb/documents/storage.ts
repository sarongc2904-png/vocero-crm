import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "@/lib/env";

export const KNOWLEDGE_EXTENSIONS = [".txt", ".pdf"] as const;
export type KnowledgeExtension = (typeof KNOWLEDGE_EXTENSIONS)[number];

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function assertSafeId(label: string, value: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} inválido para almacenamiento`);
}

function assertExtension(value: string): asserts value is KnowledgeExtension {
  if (!(KNOWLEDGE_EXTENSIONS as readonly string[]).includes(value)) {
    throw new Error("extensión de conocimiento no permitida");
  }
}

/** Ruta portable que se persiste en BD; no contiene el nombre aportado al subir. */
export function knowledgeStoragePath(
  organizationId: string,
  documentId: string,
  extension: KnowledgeExtension
): string {
  assertSafeId("organizationId", organizationId);
  assertSafeId("documentId", documentId);
  assertExtension(extension);
  return `${organizationId}/${documentId}${extension}`;
}

/** Resuelve una ruta guardada y verifica de nuevo tenant, forma y extensión. */
export function resolveKnowledgeStoragePath(
  rootDir: string,
  organizationId: string,
  storagePath: string
): string {
  assertSafeId("organizationId", organizationId);
  const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(\.[a-z]+)$/.exec(
    storagePath
  );
  if (!match || match[1] !== organizationId) {
    throw new Error("ruta de conocimiento inválida para la organización");
  }
  const extension = match[3];
  if (!extension) throw new Error("ruta de conocimiento sin extensión");
  assertExtension(extension);

  const root = path.resolve(rootDir);
  const tenantRoot = path.resolve(root, organizationId);
  const absolute = path.resolve(root, ...storagePath.split("/"));
  if (path.dirname(absolute) !== tenantRoot) {
    throw new Error("ruta de conocimiento fuera del tenant");
  }
  return absolute;
}

export function knowledgeFilePath(
  organizationId: string,
  storagePath: string
): string {
  return resolveKnowledgeStoragePath(getEnv().KNOWLEDGE_DIR, organizationId, storagePath);
}

export async function saveKnowledgeFile(
  organizationId: string,
  documentId: string,
  extension: KnowledgeExtension,
  data: Buffer | Uint8Array
): Promise<string> {
  const storagePath = knowledgeStoragePath(organizationId, documentId, extension);
  const absolute = knowledgeFilePath(organizationId, storagePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, data, { flag: "wx" });
  return storagePath;
}

export async function readKnowledgeFile(
  organizationId: string,
  storagePath: string
): Promise<Buffer> {
  return readFile(knowledgeFilePath(organizationId, storagePath));
}

export async function deleteKnowledgeFile(
  organizationId: string,
  storagePath: string
): Promise<boolean> {
  try {
    await unlink(knowledgeFilePath(organizationId, storagePath));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
