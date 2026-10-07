import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 0037 — la migración de cotizaciones solo AGREGA.
 *
 * Las migraciones corren solas al arrancar el contenedor, así que esta es la
 * red que impide que una edición futura de 0037 toque tablas existentes. No
 * necesita base de datos: revisa el SQL.
 */

const sql = readFileSync(join(process.cwd(), "drizzle", "0037_quotes.sql"), "utf8")
  // Los comentarios pueden mencionar palabras como "DROP" sin ejecutarlas.
  .replace(/--.*$/gm, "");

const QUOTE_TABLES = new Set([
  "quote",
  "quote_item",
  "quote_link",
  "quote_counter",
  "quote_settings",
]);

describe("0037_quotes.sql", () => {
  it("no borra, renombra ni altera columnas", () => {
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
    expect(sql).not.toMatch(/\bALTER\s+COLUMN\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"/i);
  });

  it("solo crea tablas nuevas de cotizaciones", () => {
    const created = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS "([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(created)).toEqual(QUOTE_TABLES);
  });

  it("solo hace ALTER TABLE sobre sus propias tablas y solo para AGREGAR restricciones", () => {
    const alters = [...sql.matchAll(/ALTER TABLE "([a-z_]+)"\s+(\w+)/g)];
    expect(alters.length).toBeGreaterThan(0);
    for (const [, table, verb] of alters) {
      expect(QUOTE_TABLES.has(table!)).toBe(true);
      expect(verb).toBe("ADD");
    }
  });

  it("solo crea índices sobre sus propias tablas", () => {
    const indexes = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "\w+" ON "([a-z_]+)"/g)];
    expect(indexes.length).toBeGreaterThan(0);
    for (const [, table] of indexes) expect(QUOTE_TABLES.has(table!)).toBe(true);
  });

  it("toda tabla nueva lleva organization_id NOT NULL", () => {
    for (const table of QUOTE_TABLES) {
      const body = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS "${table}" \\(([\\s\\S]*?)\\n\\);`))?.[1];
      expect(body, table).toBeDefined();
      expect(body!, table).toMatch(/"organization_id" text (?:PRIMARY KEY )?NOT NULL/);
    }
  });

  it("toda relación entre tablas de dominio es una FK compuesta con organization_id", () => {
    const fks = [...sql.matchAll(/FOREIGN KEY \(([^)]*)\) REFERENCES "(\w+)"\(([^)]*)\)/g)];
    expect(fks.length).toBe(7);
    for (const [, cols, , refCols] of fks) {
      expect(cols!.split(",")[0]!.trim()).toBe('"organization_id"');
      expect(refCols!.split(",")[0]!.trim()).toBe('"organization_id"');
    }
  });

  it("quote registra envío (fecha, medio, operador) amarrado al estado", () => {
    const body = sql.match(/CREATE TABLE IF NOT EXISTS "quote" \(([\s\S]*?)\n\);/)?.[1] ?? "";
    expect(body).toMatch(/"sent_at" timestamp,/);
    expect(body).toMatch(/"sent_via" text,/);
    expect(body).toMatch(/"sent_by" text REFERENCES "user"\("id"\) ON DELETE SET NULL/);
    expect(body).toMatch(/CONSTRAINT "quote_sent_ck"/);
  });

  it("está registrada en el journal justo después de 0036", () => {
    const journal = JSON.parse(
      readFileSync(join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8")
    ) as { entries: { idx: number; tag: string; when: number }[] };
    const last = journal.entries.at(-1)!;
    const previous = journal.entries.at(-2)!;
    expect(last).toMatchObject({ idx: 37, tag: "0037_quotes" });
    expect(previous.tag).toBe("0036_agent_observability_v2");
    expect(last.when).toBeGreaterThan(previous.when);
  });
});
