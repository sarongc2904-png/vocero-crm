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
    const i = journal.entries.findIndex((e) => e.tag === "0037_quotes");
    const entry = journal.entries[i]!;
    const previous = journal.entries[i - 1]!;
    expect(entry.idx).toBe(37);
    expect(previous.tag).toBe("0036_agent_observability_v2");
    expect(entry.when).toBeGreaterThan(previous.when);
  });
});

/**
 * 0038 — envío por WhatsApp. Solo agrega: una tabla nueva (quote_send), una
 * columna nullable en quote_settings y un índice/llaves sobre tablas de
 * cotizaciones. No toca ninguna tabla anterior a 0037.
 */
const sql38 = readFileSync(join(process.cwd(), "drizzle", "0038_quote_send.sql"), "utf8").replace(/--.*$/gm, "");
const QUOTE_TABLES_38 = new Set([...QUOTE_TABLES, "quote_send"]);

describe("0038_quote_send.sql", () => {
  it("no borra, renombra, altera columnas ni toca datos", () => {
    expect(sql38).not.toMatch(/\bDROP\b/i);
    expect(sql38).not.toMatch(/\bRENAME\b/i);
    expect(sql38).not.toMatch(/\bALTER\s+COLUMN\b/i);
    expect(sql38).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"/i);
  });

  it("solo crea quote_send y solo ALTERa tablas de cotizaciones para AGREGAR", () => {
    const created = [...sql38.matchAll(/CREATE TABLE IF NOT EXISTS "([a-z_]+)"/g)].map((m) => m[1]);
    expect(created).toEqual(["quote_send"]);
    const alters = [...sql38.matchAll(/ALTER TABLE "([a-z_]+)"\s+(\w+)/g)];
    expect(alters.length).toBeGreaterThan(0);
    for (const [, table, verb] of alters) {
      expect(QUOTE_TABLES_38.has(table!), table).toBe(true);
      expect(verb).toBe("ADD");
    }
    const indexes = [...sql38.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "\w+" ON "([a-z_]+)"/g)];
    expect(indexes.length).toBeGreaterThan(0);
    for (const [, table] of indexes) expect(QUOTE_TABLES_38.has(table!), table).toBe(true);
  });

  it("la columna nueva de quote_settings es nullable (no rompe filas existentes)", () => {
    expect(sql38).toMatch(/ADD COLUMN IF NOT EXISTS "whatsapp_template_id" text;/);
  });

  it("quote_send lleva organization_id y no tiene columnas de token ni de texto", () => {
    const body = sql38.match(/CREATE TABLE IF NOT EXISTS "quote_send" \(([\s\S]*?)\n\);/)?.[1];
    expect(body).toBeDefined();
    expect(body!).toMatch(/"organization_id" text NOT NULL/);
    expect(body!).not.toMatch(/"(token|token_hash|text|body|caption|url)"/);
  });

  it("toda relación con tablas de dominio es una FK compuesta con organization_id", () => {
    const fks = [...sql38.matchAll(/FOREIGN KEY \(([^)]*)\) REFERENCES "(\w+)"\(([^)]*)\)/g)];
    expect(fks.length).toBe(5);
    for (const [, cols, , refCols] of fks) {
      expect(cols!.split(",")[0]!.trim()).toBe('"organization_id"');
      expect(refCols!.split(",")[0]!.trim()).toBe('"organization_id"');
    }
  });

  it("está en el journal justo después de 0037", () => {
    const journal = JSON.parse(
      readFileSync(join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8")
    ) as { entries: { idx: number; tag: string; when: number }[] };
    const last = journal.entries.at(-1)!;
    expect(last).toMatchObject({ idx: 38, tag: "0038_quote_send" });
    expect(journal.entries.at(-2)!.tag).toBe("0037_quotes");
    expect(last.when).toBeGreaterThan(journal.entries.at(-2)!.when);
  });
});
