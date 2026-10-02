import { createHash } from "node:crypto";

/**
 * Primitivas de determinismo del Laboratorio (Action Trace v2, Evidence
 * Snapshot y juez reproducible).
 *
 * `JSON.stringify` NO es canónico: el orden de las claves depende de cómo se
 * construyó el objeto, así que dos representaciones del mismo hecho producen
 * cadenas distintas y por tanto digests distintos. Estas funciones fijan un
 * orden total (claves ordenadas en cada nivel) para que un mismo valor
 * semántico produzca SIEMPRE la misma cadena y el mismo hash.
 *
 * Sin dependencias del dominio: se pueden usar desde el runner, el juez y los
 * tests sin arrastrar la base de datos ni el proveedor de IA.
 */

/** Ordena recursivamente las claves de un valor JSON. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    // El orden de un array es significativo: NO se ordena.
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      // `undefined` se omite igual que haría JSON.stringify, pero de forma
      // explícita para que la decisión no dependa del motor.
      if (entry === undefined) continue;
      sorted[key] = canonicalize(entry);
    }
    return sorted;
  }
  return value;
}

/** Serialización canónica estable de un valor JSON. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** SHA-256 en hexadecimal de un texto UTF-8. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** SHA-256 de la serialización canónica de un valor JSON. */
export function canonicalDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Copia profunda por serialización, para congelar un valor antes de que otra
 * capa lo mute. `structuredClone` no está disponible en todos los runtimes del
 * repo (el self-test corre en Node, pero los bundlers de Next no lo garantizan
 * en todos los targets), así que se usa el camino JSON, que además obliga a que
 * lo congelado sea serializable — exactamente lo que se persiste.
 */
export function freezeJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
