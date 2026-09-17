import type { OrganizationRole } from "@/lib/auth/roles";

export function canManageMember(input: {
  actorRole: OrganizationRole;
  targetRole: OrganizationRole;
  isSuperadmin?: boolean;
}): boolean {
  if (input.targetRole === "owner") return false;
  if (input.isSuperadmin || input.actorRole === "owner") return true;
  return input.actorRole === "admin" && input.targetRole === "agent";
}

export function canAssignRole(input: {
  actorRole: OrganizationRole;
  nextRole: Exclude<OrganizationRole, "owner">;
  isSuperadmin?: boolean;
}): boolean {
  if (input.isSuperadmin || input.actorRole === "owner") return true;
  return input.actorRole === "admin" && input.nextRole === "agent";
}
