import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("entorno de tests", () => {
  it("vitest funciona", () => {
    expect(1 + 1).toBe(2);
  });

  it("el smoke productivo valida métricas y dead letters de la cola", () => {
    const smoke = readFileSync(
      resolve(process.cwd(), "scripts/production-smoke.mjs"),
      "utf8"
    );

    expect(smoke).toContain("jobs?.pending");
    expect(smoke).toContain("jobs?.leased");
    expect(smoke).toContain("jobs?.deadLetter");
    expect(smoke).toContain("cola durable sin dead letters");
  });
});
