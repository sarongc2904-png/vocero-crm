import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import type { OrganizationRole } from "@/lib/auth/roles";
import { resolveActiveMembership } from "@/server/auth/organizations";

export type SessionContext = {
  userId: string;
  organizationId: string;
  role: OrganizationRole;
};

export class UnauthorizedError extends Error {
  constructor(message = "No autenticado") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  constructor(message = "Sin acceso a una organización") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Sesión + organización activa para route handlers y server components.
 * Lanza UnauthorizedError si no hay sesión u organización.
 */
export async function requireSession(): Promise<SessionContext> {
  const auth = getAuth();
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) throw new UnauthorizedError();
  const membership = await resolveActiveMembership(
    session.user.id,
    session.session.activeOrganizationId
  );
  if (!membership) {
    throw new ForbiddenError("El usuario no pertenece a ninguna organización");
  }
  if (membership.usedFallback) {
    await auth.api.setActiveOrganization({
      headers: requestHeaders,
      body: { organizationId: membership.organizationId },
    });
  }
  return {
    userId: session.user.id,
    organizationId: membership.organizationId,
    role: membership.role,
  };
}

/** Igual que requireSession pero devuelve null en vez de lanzar. */
export async function getSessionOrNull(): Promise<SessionContext | null> {
  try {
    return await requireSession();
  } catch {
    return null;
  }
}
