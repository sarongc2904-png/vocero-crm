import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { getSessionState } from "@/lib/auth/session";
import { normalizeThemePreference, THEME_COOKIE } from "@/lib/theme";
import { getBranding } from "@/server/branding";
import { AppShell } from "@/components/app-shell";
import { resolveBuildCommit } from "@/lib/version";
import { agendaEnabled } from "@/server/agenda/flag";
import { quotesEnabled } from "@/server/quotes/flag";
import { hasOrganizationPermission } from "@/lib/auth/permissions";
import { getCommercialAccess } from "@/server/commercial/entitlement";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  /**
   * AUTH-2 — Tres estados, tres respuestas distintas.
   *
   * Antes `getSessionOrNull()` devolvía `null` tanto para "no hay sesión" como
   * para "hay sesión pero la cuenta no tiene organización", y ambos caían en
   * `redirect("/login")`. Con credenciales correctas y sin organización el
   * usuario rebotaba login → inbox → login para siempre, sin ningún mensaje.
   *
   * Ahora "sin organización" tiene su propia pantalla terminal, que explica la
   * situación y ofrece cerrar sesión. No se crea ningún tenant.
   */
  const state = await getSessionState();
  if (state.status === "anonymous") redirect("/login");
  if (state.status === "no_organization") redirect("/organization-required");

  const session = state.session;

  if (!session.isSuperadmin) {
    const access = await getCommercialAccess(session.organizationId).catch(
      () => null
    );
    if (!access?.allowed) redirect("/access-required");
  }

  const branding = await getBranding(session.organizationId);
  const authSession = await getAuth().api.getSession({
    headers: await headers(),
  });
  const theme = normalizeThemePreference(
    (await cookies()).get(THEME_COOKIE)?.value
  );

  return (
    <AppShell
      branding={branding}
      userName={authSession?.user.name ?? "Usuario"}
      role={session.role}
      isSuperadmin={session.isSuperadmin}
      activeOrganizationId={session.organizationId}
      theme={theme}
      // Se resuelve aquí, en el servidor: el cliente no ve `SOURCE_COMMIT`.
      commit={resolveBuildCommit()}
      // Qué módulos opcionales existen se decide en el servidor y baja por
      // prop, igual que los canales de la Bandeja. El nav es un componente de
      // cliente: no puede —ni debe— leer variables de entorno.
      agenda={agendaEnabled()}
      // 0037 — bandera de la instancia Y permiso del usuario.
      quotes={
        quotesEnabled() &&
        hasOrganizationPermission(session.role, "quotes.read", { isSuperadmin: session.isSuperadmin })
      }
    >
      {children}
    </AppShell>
  );
}
