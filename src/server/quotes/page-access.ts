import { notFound } from "next/navigation";
import { hasOrganizationPermission, type OrganizationPermission } from "@/lib/auth/permissions";
import { requireSession, type SessionContext } from "@/lib/auth/session";
import { quotesEnabled } from "@/server/quotes/flag";

export type QuotesPageAccess = {
  session: SessionContext;
  can: { manage: boolean; publish: boolean };
};

/**
 * Puerta de las pantallas `/quotes/*`. Con la bandera apagada o sin el
 * permiso pedido, la pantalla NO EXISTE (`notFound()`), igual que la API
 * responde 404: no se revela que el módulo existe. El layout de `(app)` ya
 * resolvió login, organización y acceso comercial.
 */
export async function requireQuotesPage(
  permission: OrganizationPermission = "quotes.read"
): Promise<QuotesPageAccess> {
  if (!quotesEnabled()) notFound();
  const session = await requireSession();
  const has = (p: OrganizationPermission) =>
    hasOrganizationPermission(session.role, p, { isSuperadmin: session.isSuperadmin });
  if (!has(permission)) notFound();
  return { session, can: { manage: has("quotes.manage"), publish: has("quotes.publish") } };
}
