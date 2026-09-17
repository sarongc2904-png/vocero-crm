import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

describe("RBAC governance gate", () => {
  it("suspensión es reversible, tenant-scoped y no permite autosuspensión", () => {
    const route = source("src/app/api/settings/team/status/route.ts");
    expect(route).toContain('withOrgPermissions(["users.suspend"]');
    expect(route).toContain("scoped(schema.member.organizationId, session.organizationId)");
    expect(route).toContain("target.userId === session.userId");
    expect(route).toContain("setMemberSuspension");
    expect(route).toContain('"member.suspend"');
    expect(route).toContain('"member.restore"');
  });

  it("una membership suspendida no puede producir acceso activo", () => {
    const session = source("src/lib/auth/session.ts");
    expect(session).toContain("isMemberSuspended");
    expect(session).toContain("firstUnsuspendedMembership");
    expect(session).toContain("El acceso a esta organización está suspendido");
  });

  it("borrado permanente exige confirmación y protege cuentas multi-tenant", () => {
    const route = source("src/app/api/settings/team/permanent-delete/route.ts");
    expect(route).toContain('z.literal("DELETE")');
    expect(route).toContain('withOrgPermissions(["users.delete"]');
    expect(route).toContain("otherMembership");
    expect(route).toContain('"other_memberships"');
    expect(route).toContain('"user.permanent_delete"');
  });

  it("equipos y asignaciones conservan organization_id en todas las mutaciones", () => {
    const teams = source("src/server/auth/teams.ts");
    expect(teams).toContain("where organization_id = ${organizationId}");
    expect(teams).toContain("t.organization_id = ${input.organizationId}");
    expect(teams).toContain("tm.organization_id = ${input.organizationId}");
    expect(teams).toContain("m.organization_id = t.organization_id");
  });

  it("auditoría privilegiada siempre escribe y lee dentro del tenant activo", () => {
    const audit = source("src/server/auth/audit.ts");
    expect(audit).toContain("${session.organizationId}");
    expect(audit).toContain('session.isSuperadmin ? "superadmin" : "member"');
    expect(audit).toContain("where organization_id = ${organizationId}");
  });

  it("superadmin puede cambiar de tenant sólo si el tenant existe", () => {
    const route = source("src/app/api/organizations/active/route.ts");
    expect(route).toContain("if (session.isSuperadmin)");
    expect(route).toContain("organizationExists(body.data.organizationId)");
    expect(route).toContain("schema.session.id, session.sessionId");
    expect(route).toContain('action: "tenant.switch"');
  });

  it("usuario normal conserva validación de membership y suspensión al cambiar tenant", () => {
    const route = source("src/app/api/organizations/active/route.ts");
    expect(route).toContain("resolveActiveMembership");
    expect(route).toContain("membership.organizationId !== body.data.organizationId");
    expect(route).toContain("isMemberSuspended(body.data.organizationId, session.userId)");
    expect(route).toContain('"organization_forbidden"');
    expect(route).toContain('"organization_suspended"');
  });

  it("migración de gobierno contiene suspensión, equipos y auditoría", () => {
    const migration = source("drizzle/0018_rbac_governance.sql");
    expect(migration).toContain('"suspended_at"');
    expect(migration).toContain('"suspension_reason"');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "team"');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "team_member"');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "privileged_audit_log"');
  });
});
