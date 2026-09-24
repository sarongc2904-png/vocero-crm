import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("auditoría comercial de superadmin", () => {
  it("persiste actor, acción, objetivo y estados antes/después", () => {
    const admin = source("src/server/commercial/admin.ts");
    const route = source("src/app/api/admin/commercial/route.ts");
    const migration = source("drizzle/0028_commercial_admin_audit.sql");

    expect(migration).toContain('CREATE TABLE "commercial_admin_audit"');
    expect(migration).toContain('"actor_user_id" text NOT NULL');
    expect(migration).toContain('"before_state" jsonb');
    expect(migration).toContain('"after_state" jsonb');

    expect(admin).toContain("recordCommercialAudit");
    expect(admin).toContain("beforeState");
    expect(admin).toContain("afterState");
    expect(admin).toContain('action: `account.${input.action}`');
    expect(admin).toContain('action: "plan.update"');
    expect(admin).toContain('action: "client.create"');

    expect(route).toContain("actorUserId: session.userId");
  });

  it("no registra la contraseña temporal en el resultado auditado", () => {
    const admin = source("src/server/commercial/admin.ts");
    const resultStart = admin.indexOf("const result = {");
    const auditStart = admin.indexOf("await recordCommercialAudit", resultStart);
    const auditedBlock = admin.slice(resultStart, auditStart);

    expect(auditedBlock).not.toContain("password:");
  });
});
