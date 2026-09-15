export const ORGANIZATION_ROLES = ["owner", "admin", "agent"] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export function normalizeOrganizationRole(
  role: string
): OrganizationRole | null {
  // Compatibilidad durante el despliegue de la migración 0016. Después de
  // migrar, la base ya no conserva `member` como rol operativo.
  if (role === "member") return "agent";
  return ORGANIZATION_ROLES.includes(role as OrganizationRole)
    ? (role as OrganizationRole)
    : null;
}

export function hasOrganizationRole(
  role: string,
  allowed: readonly OrganizationRole[]
): boolean {
  const normalized = normalizeOrganizationRole(role);
  return normalized !== null && allowed.includes(normalized);
}
