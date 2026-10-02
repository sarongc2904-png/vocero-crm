import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("hardening de FKs multi-tenant", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "drizzle/0035_tenant_composite_foreign_keys.sql"),
    "utf8"
  );
  const releaseGate = readFileSync(
    resolve(process.cwd(), "scripts/postgres-release-gate.mjs"),
    "utf8"
  );

  it("descubre todas las relaciones tenant-aware y valida cada FK compuesta", () => {
    expect(migration).toContain("array_length(fk.conkey, 1) = 1");
    expect(migration).toContain("organization_column.attname = 'organization_id'");
    expect(migration).toContain("FOREIGN KEY (organization_id, %I)");
    expect(migration).toContain("NOT VALID");
    expect(migration).toContain("VALIDATE CONSTRAINT");
  });

  it("SET NULL conserva organization_id y sólo limpia la referencia", () => {
    expect(migration).toContain(
      "WHEN 'n' THEN format('SET NULL (%I)', relation.child_column)"
    );
  });

  it("el release gate vigila cobertura total y rechaza booking cross-tenant", () => {
    expect(releaseGate).toContain("tenantFkGaps");
    expect(releaseGate).toContain("cross_tenant_professional_fk");
    expect(releaseGate).toContain('reason?.code === "23503"');
  });
});
