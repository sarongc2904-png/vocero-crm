import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { isConfiguredSuperadmin } from "@/lib/auth/permissions";
import type { OrganizationRole } from "@/lib/auth/roles";
import {
  organizationExists,
  resolveActiveMembership,
} from "@/server/auth/organizations";
import {
  firstUnsuspendedMembership,
  isMemberSuspended,
} from "@/server/auth/suspension";

export type SessionContext = {
  sessionId: string;
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  isSuperadmin: boolean;
};

export class UnauthorizedError extends Error {
  constructor(message = "No autenticado") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * AUTH-2 — Motivo del bloqueo. `no_membership` significa "la cuenta es válida
 * pero no pertenece a ninguna organización"; es un estado terminal que el
 * usuario debe VER explicado, no un "no autenticado" que lo devuelva al login.
 */
export type ForbiddenReason = "no_membership" | "suspended" | "generic";

export class ForbiddenError extends Error {
  constructor(
    message = "Sin acceso a una organización",
    readonly reason: ForbiddenReason = "generic"
  ) {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Sesión + organización activa para route handlers y server components.
 *
 * Un superadmin NO se convierte en member de todos los tenants. Su capacidad
 * global se valida por separado y sólo opera sobre un organizationId activo y
 * existente. Los usuarios normales siguen limitados estrictamente a sus
 * memberships. Una membership suspendida nunca produce acceso al tenant.
 */
export async function requireSession(): Promise<SessionContext> {
  const auth = getAuth();
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) throw new UnauthorizedError();

  const isSuperadmin = isConfiguredSuperadmin({
    id: session.user.id,
    email: session.user.email,
  });
  const activeOrganizationId = session.session.activeOrganizationId;

  if (
    isSuperadmin &&
    activeOrganizationId &&
    (await organizationExists(activeOrganizationId))
  ) {
    return {
      sessionId: session.session.id,
      userId: session.user.id,
      organizationId: activeOrganizationId,
      role: "owner",
      isSuperadmin: true,
    };
  }

  const membership = await resolveActiveMembership(
    session.user.id,
    activeOrganizationId
  );
  if (!membership) {
    throw new ForbiddenError(
      "El usuario no pertenece a ninguna organización",
      "no_membership"
    );
  }

  if (await isMemberSuspended(membership.organizationId, session.user.id)) {
    const fallback = await firstUnsuspendedMembership(session.user.id);
    if (!fallback) {
      throw new ForbiddenError(
        "El acceso a esta organización está suspendido",
        "suspended"
      );
    }
    await auth.api.setActiveOrganization({
      headers: requestHeaders,
      body: { organizationId: fallback.organizationId },
    });
    return {
      sessionId: session.session.id,
      userId: session.user.id,
      organizationId: fallback.organizationId,
      role: fallback.role,
      isSuperadmin,
    };
  }

  if (membership.usedFallback) {
    await auth.api.setActiveOrganization({
      headers: requestHeaders,
      body: { organizationId: membership.organizationId },
    });
  }
  return {
    sessionId: session.session.id,
    userId: session.user.id,
    organizationId: membership.organizationId,
    role: membership.role,
    isSuperadmin,
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

/**
 * AUTH-2 — Estado de sesión SIN perder el motivo.
 *
 * `getSessionOrNull()` colapsaba dos situaciones muy distintas en un mismo
 * `null`: "no hay sesión" y "hay sesión pero la cuenta no tiene organización".
 * El layout de `(app)` mandaba ambas a `/login`, así que un usuario autenticado
 * sin organización quedaba en un bucle login → inbox → login sin ver nunca una
 * explicación.
 *
 * Este helper separa los tres estados para que cada uno reciba la respuesta
 * correcta. Un error inesperado (por ejemplo la base de datos caída) NO se
 * disfraza de "sin acceso": se relanza, porque ocultarlo convertiría una avería
 * en un bucle de login.
 */
export type SessionState =
  | { status: "ok"; session: SessionContext }
  | { status: "anonymous" }
  | { status: "no_organization"; reason: ForbiddenReason };

export async function getSessionState(): Promise<SessionState> {
  try {
    return { status: "ok", session: await requireSession() };
  } catch (error) {
    if (error instanceof UnauthorizedError) return { status: "anonymous" };
    if (error instanceof ForbiddenError) {
      return { status: "no_organization", reason: error.reason };
    }
    throw error;
  }
}
