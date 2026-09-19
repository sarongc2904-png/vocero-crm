import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("plan comercial centralizado", () => {
  it("define precio y trial una sola vez en el plan", () => {
    const migration = readFileSync(
      "drizzle/0023_commercial_entitlements.sql",
      "utf8"
    );
    expect(migration).toContain("139700");
    expect(migration).toContain("'MXN', 3");
    expect(migration).toContain("Instalaciones existentes conservan acceso");
  });
});
