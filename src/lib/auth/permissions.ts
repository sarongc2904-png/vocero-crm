import type { OrganizationRole } from "@/lib/auth/roles";

export const ORGANIZATION_PERMISSIONS = [
  "contacts.read",
  "contacts.create",
  "contacts.update",
  "contacts.delete",
  "conversations.read",
  "conversations.reply",
  "conversations.assign",
  "conversations.delete",
  "leads.qualify",
  "pipeline.move",
  "appointments.read",
  "appointments.create",
  "appointments.reschedule",
  "appointments.cancel",
  "ai.use",
  "ai.configure",
  "users.read",
  "users.create",
  "users.update",
  "users.suspend",
  "users.delete",
  "teams.read",
  "teams.manage",
  "audit.read",
  "bot_api.manage",
  "branding.manage",
  "settings.read",
  "settings.update",
] as const;

export type OrganizationPermission = (typeof ORGANIZATION_PERMISSIONS)[number];

const ALL_PERMISSIONS = new Set<OrganizationPermission>(ORGANIZATION_PERMISSIONS);

const ADMIN_PERMISSIONS = new Set<OrganizationPermission>([
  "contacts.read",
  "contacts.create",
  "contacts.update",
  "contacts.delete",
  "conversations.read",
  "conversations.reply",
  "conversations.assign",
  "conversations.delete",
  "leads.qualify",
  "pipeline.move",
  "appointments.read",
  "appointments.create",
  "appointments.reschedule",
  "appointments.cancel",
  "ai.use",
  "ai.configure",
  "users.read",
  "users.create",
  "users.update",
  "users.suspend",
  "teams.read",
  "teams.manage",
  "settings.read",
  "settings.update",
]);

const AGENT_PERMISSIONS = new Set<OrganizationPermission>([
  "contacts.read",
  "contacts.create",
  "contacts.update",
  "conversations.read",
  "conversations.reply",
  "conversations.assign",
  "leads.qualify",
  "pipeline.move",
  "appointments.read",
  "appointments.create",
  "appointments.reschedule",
  "appointments.cancel",
  "ai.use",
  "teams.read",
]);

const ROLE_PERMISSIONS: Record<OrganizationRole, ReadonlySet<OrganizationPermission>> = {
  owner: ALL_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
  agent: AGENT_PERMISSIONS,
};

export function hasOrganizationPermission(
  role: OrganizationRole,
  permission: OrganizationPermission,
  options?: { isSuperadmin?: boolean }
): boolean {
  if (options?.isSuperadmin) return true;
  return ROLE_PERMISSIONS[role].has(permission);
}

function configuredValues(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isConfiguredSuperadmin(input: { id: string; email?: string | null }): boolean {
  const ids = configuredValues("SUPERADMIN_USER_IDS");
  const emails = configuredValues("SUPERADMIN_EMAILS");
  return ids.has(input.id.toLowerCase()) || Boolean(input.email && emails.has(input.email.toLowerCase()));
}
