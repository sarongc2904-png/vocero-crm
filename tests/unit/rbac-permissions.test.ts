import { afterEach, describe, expect, it } from "vitest";
import {
  hasOrganizationPermission,
  isConfiguredSuperadmin,
} from "@/lib/auth/permissions";

const ORIGINAL_IDS = process.env.SUPERADMIN_USER_IDS;
const ORIGINAL_EMAILS = process.env.SUPERADMIN_EMAILS;

afterEach(() => {
  if (ORIGINAL_IDS === undefined) delete process.env.SUPERADMIN_USER_IDS;
  else process.env.SUPERADMIN_USER_IDS = ORIGINAL_IDS;
  if (ORIGINAL_EMAILS === undefined) delete process.env.SUPERADMIN_EMAILS;
  else process.env.SUPERADMIN_EMAILS = ORIGINAL_EMAILS;
});

describe("RBAC granular por tenant", () => {
  it("owner tiene todas las capacidades sensibles", () => {
    expect(hasOrganizationPermission("owner", "users.delete")).toBe(true);
    expect(hasOrganizationPermission("owner", "contacts.delete")).toBe(true);
    expect(hasOrganizationPermission("owner", "ai.configure")).toBe(true);
    expect(hasOrganizationPermission("owner", "settings.update")).toBe(true);
  });

  it("admin opera el CRM pero no puede borrar usuarios", () => {
    expect(hasOrganizationPermission("admin", "leads.qualify")).toBe(true);
    expect(hasOrganizationPermission("admin", "conversations.reply")).toBe(true);
    expect(hasOrganizationPermission("admin", "users.suspend")).toBe(true);
    expect(hasOrganizationPermission("admin", "users.delete")).toBe(false);
  });

  it("agent trabaja leads, conversaciones y agenda sin administración sensible", () => {
    expect(hasOrganizationPermission("agent", "contacts.update")).toBe(true);
    expect(hasOrganizationPermission("agent", "pipeline.move")).toBe(true);
    expect(hasOrganizationPermission("agent", "appointments.reschedule")).toBe(true);
    expect(hasOrganizationPermission("agent", "conversations.delete")).toBe(false);
    expect(hasOrganizationPermission("agent", "settings.update")).toBe(false);
    expect(hasOrganizationPermission("agent", "users.create")).toBe(false);
  });

  it("superadmin atraviesa permisos, pero sólo cuando la capacidad está explícitamente marcada", () => {
    expect(
      hasOrganizationPermission("agent", "users.delete", { isSuperadmin: true })
    ).toBe(true);
    expect(hasOrganizationPermission("agent", "users.delete")).toBe(false);
  });
});

describe("identidad de superadmin", () => {
  it("no existe un superadmin implícito", () => {
    delete process.env.SUPERADMIN_USER_IDS;
    delete process.env.SUPERADMIN_EMAILS;
    expect(isConfiguredSuperadmin({ id: "user_1", email: "owner@example.com" })).toBe(false);
  });

  it("acepta IDs o emails configurados explícitamente", () => {
    process.env.SUPERADMIN_USER_IDS = "user_root,user_other";
    process.env.SUPERADMIN_EMAILS = "admin@example.com";
    expect(isConfiguredSuperadmin({ id: "user_root", email: "x@example.com" })).toBe(true);
    expect(isConfiguredSuperadmin({ id: "x", email: "ADMIN@example.com" })).toBe(true);
    expect(isConfiguredSuperadmin({ id: "stranger", email: "x@example.com" })).toBe(false);
  });
});
