import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("registro de migraciones", () => {
  it("incluye cada SQL en el journal que ejecuta drizzle", () => {
    const root = resolve(process.cwd(), "drizzle");
    const sqlTags = readdirSync(root)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .map((name) => name.replace(/\.sql$/, ""))
      .sort();
    const journal = JSON.parse(
      readFileSync(resolve(root, "meta/_journal.json"), "utf8")
    ) as { entries: Array<{ idx: number; tag: string }> };

    expect(journal.entries.map((entry) => entry.tag).sort()).toEqual(sqlTags);
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, index) => index)
    );
  });
});
