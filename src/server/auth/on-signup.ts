import { resolveActiveMembership } from "@/server/auth/organizations";

/** Organización activa de un usuario (su primera membresía). */
export async function resolveActiveOrganizationId(
  userId: string
): Promise<string | null> {
  return (await resolveActiveMembership(userId, null))?.organizationId ?? null;
}

/** @deprecated Usa resolveActiveMembership(userId, activeOrganizationId). */
export async function resolveMembership(
  userId: string
): Promise<{ organizationId: string; role: string } | null> {
  return resolveActiveMembership(userId, null);
}
