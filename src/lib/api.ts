import { z } from "zod";
import {
  ForbiddenError,
  requireSession,
  UnauthorizedError,
  type SessionContext,
} from "@/lib/auth/session";
import {
  hasOrganizationPermission,
  type OrganizationPermission,
} from "@/lib/auth/permissions";
import {
  hasOrganizationRole,
  type OrganizationRole,
} from "@/lib/auth/roles";
import { getCommercialAccess } from "@/server/commercial/entitlement";

/** Respuesta de error estándar de la API interna (contrato api.md). */
export function apiError(
  status: number,
  code: string,
  message: string
): Response {
  return Response.json({ error: { code, message } }, { status });
}

type AuthOptions = {
  /**
   * Permite consultar superficies mínimas necesarias para explicar o resolver
   * el bloqueo comercial. No debe usarse en operaciones del CRM.
   */
  allowBlockedCommercialAccess?: boolean;
};

async function commercialGate(
  session: SessionContext,
  options: AuthOptions
): Promise<Response | null> {
  if (session.isSuperadmin || options.allowBlockedCommercialAccess) return null;

  const access = await getCommercialAccess(session.organizationId).catch(
    () => null
  );
  if (access?.allowed) return null;

  return apiError(
    402,
    "subscription_required",
    "El plan de esta organización no permite usar el CRM en este momento"
  );
}

/**
 * Envuelve un route handler autenticado: resuelve la sesión (401 si no hay),
 * aplica el gate comercial (402 si el tenant no tiene acceso) y captura errores
 * no controlados (500 sin stack).
 */
export function withAuth<Args extends unknown[]>(
  handler: (session: SessionContext, ...args: Args) => Promise<Response>
): (...args: Args) => Promise<Response> {
  return withAuthOptions({}, handler);
}

export function withAuthOptions<Args extends unknown[]>(
  options: AuthOptions,
  handler: (session: SessionContext, ...args: Args) => Promise<Response>
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    let session: SessionContext;
    try {
      session = await requireSession();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        return apiError(401, "unauthorized", "No autenticado");
      }
      if (err instanceof ForbiddenError) {
        return apiError(403, "no_membership", err.message);
      }
      throw err;
    }

    const blocked = await commercialGate(session, options);
    if (blocked) return blocked;

    try {
      return await handler(session, ...args);
    } catch (err) {
      console.error("[api] error no controlado:", err);
      return apiError(500, "internal", "Error interno");
    }
  };
}

/** Gate heredado por rol; se conserva para rutas aún no migradas a permisos. */
export function withOrgRoles<Args extends unknown[]>(
  roles: readonly OrganizationRole[],
  handler: (session: SessionContext, ...args: Args) => Promise<Response>
): (...args: Args) => Promise<Response> {
  return withAuth(async (session, ...args: Args) => {
    if (!session.isSuperadmin && !hasOrganizationRole(session.role, roles)) {
      return apiError(
        403,
        "forbidden",
        "Tu rol no permite realizar esta acción en la organización activa"
      );
    }
    return handler(session, ...args);
  });
}

/**
 * Gate granular de RBAC. El superadmin puede atravesarlo, pero sólo después de
 * que requireSession haya resuelto y validado un tenant activo explícito.
 */
export function withOrgPermissions<Args extends unknown[]>(
  permissions: readonly OrganizationPermission[],
  handler: (session: SessionContext, ...args: Args) => Promise<Response>
): (...args: Args) => Promise<Response> {
  return withOrgPermissionsOptions({}, permissions, handler);
}

export function withOrgPermissionsOptions<Args extends unknown[]>(
  options: AuthOptions,
  permissions: readonly OrganizationPermission[],
  handler: (session: SessionContext, ...args: Args) => Promise<Response>
): (...args: Args) => Promise<Response> {
  return withAuthOptions(options, async (session, ...args: Args) => {
    const allowed = permissions.every((permission) =>
      hasOrganizationPermission(session.role, permission, {
        isSuperadmin: session.isSuperadmin,
      })
    );
    if (!allowed) {
      return apiError(
        403,
        "forbidden",
        "No tienes permisos para realizar esta acción en la organización activa"
      );
    }
    return handler(session, ...args);
  });
}

/** Parsea el body JSON con un esquema Zod; inválido → Response 422. */
export async function parseBody<T>(
  req: Request,
  schema: z.ZodType<T>
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return {
      ok: false,
      response: apiError(422, "invalid_body", "El body debe ser JSON válido"),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      response: apiError(422, "invalid_body", detail),
    };
  }
  return { ok: true, data: parsed.data };
}
