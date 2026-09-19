import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

describe("Inbox RBAC + assignment gate", () => {
  it("separa lectura, respuesta y control de IA por permiso", () => {
    const list = source("src/app/api/conversations/route.ts");
    const detail = source("src/app/api/conversations/[id]/route.ts");
    const messages = source("src/app/api/conversations/[id]/messages/route.ts");

    expect(list).toContain('withOrgPermissions(["conversations.read"]');
    expect(detail).toContain('withOrgPermissions(["conversations.read"]');
    expect(detail).toContain('"ai.use"');
    expect(messages).toContain('withOrgPermissions(["conversations.read"]');
    expect(messages).toContain('withOrgPermissions(["conversations.reply"]');
  });

  it("contactos usa permisos granulares para leer, crear y editar", () => {
    const list = source("src/app/api/contacts/route.ts");
    const detail = source("src/app/api/contacts/[id]/route.ts");

    expect(list).toContain('withOrgPermissions(["contacts.read"]');
    expect(list).toContain('withOrgPermissions(["contacts.create"]');
    expect(detail).toContain('withOrgPermissions(["contacts.read"]');
    expect(detail).toContain('withOrgPermissions(["contacts.update"]');
  });

  it("asignación nunca acepta conversación, agente o equipo de otro tenant", () => {
    const assignment = source("src/server/inbox/assignment.ts");

    expect(assignment).toContain("c.organization_id = ${input.organizationId}");
    expect(assignment).toContain("m.organization_id = c.organization_id");
    expect(assignment).toContain("t.organization_id = c.organization_id");
    expect(assignment).toContain("m.suspended_at is null");
    expect(assignment).toContain("organization_id = ${input.organizationId}");
  });

  it("API de asignación exige permiso explícito y registra auditoría", () => {
    const route = source("src/app/api/conversations/[id]/assignment/route.ts");

    expect(route).toContain('withOrgPermissions(\n  ["conversations.read"]');
    expect(route).toContain('withOrgPermissions(\n  ["conversations.assign"]');
    expect(route).toContain('action: "conversation.assign"');
  });

  it("migración exige exactamente un destino por conversación", () => {
    const migration = source("drizzle/0019_inbox_assignment.sql");

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "conversation_assignment"');
    expect(migration).toContain('CHECK (num_nonnulls("member_id", "team_id") = 1)');
    expect(migration).toContain('"organization_id" text NOT NULL');
  });

  it("roles operativos incluyen capacidad explícita de asignación", () => {
    const permissions = source("src/lib/auth/permissions.ts");
    expect(permissions).toContain('"conversations.assign"');
  });
});
