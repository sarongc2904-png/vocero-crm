import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Navegación: con COTIZACIONES apagada, el menú no muestra la entrada; el
 * layout del CRM decide con la bandera Y el permiso `quotes.read`.
 */

const h = vi.hoisted(() => ({ role: "owner" as "owner" | "admin" | "agent", isSuperadmin: false }));

vi.mock("@/lib/auth/session", () => ({
  getSessionState: async () => ({
    status: "ok",
    session: { sessionId: "s", userId: "u", organizationId: "org_x", role: h.role, isSuperadmin: h.isSuperadmin },
  }),
}));
vi.mock("@/server/commercial/entitlement", () => ({ getCommercialAccess: async () => ({ allowed: true }) }));
vi.mock("@/server/branding", () => ({
  getBranding: async () => ({ name: "Negocio", accent: "#0d5bff", currency: "MXN", favicon: null }),
}));
vi.mock("@/lib/auth", () => ({ getAuth: () => ({ api: { getSession: async () => ({ user: { name: "Ana" } }) } }) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  h.role = "owner";
  h.isSuperadmin = false;
});

async function layoutQuotesProp(): Promise<boolean> {
  const { default: AppLayout } = await import("@/app/(app)/layout");
  const element = (await AppLayout({ children: null })) as { props: { quotes?: boolean } };
  return Boolean(element.props.quotes);
}

describe("navegación de cotizaciones", () => {
  it("buildPrimaryNav no incluye /quotes con el módulo apagado", async () => {
    const { buildPrimaryNav } = await import("@/components/app-nav");
    for (const agenda of [false, true]) {
      expect(buildPrimaryNav({ agenda, quotes: false }).map((i) => i.href)).not.toContain("/quotes");
    }
  });

  it("buildPrimaryNav la coloca después de Prospectos (y de Citas si hay agenda)", async () => {
    const { buildPrimaryNav } = await import("@/components/app-nav");
    expect(buildPrimaryNav({ agenda: false, quotes: true }).map((i) => i.href)).toEqual([
      "/inbox",
      "/pipeline",
      "/quotes",
      "/contacts",
    ]);
    expect(buildPrimaryNav({ agenda: true, quotes: true }).map((i) => i.href)).toEqual([
      "/inbox",
      "/pipeline",
      "/bookings",
      "/quotes",
      "/contacts",
    ]);
  });

  it("el layout del CRM apaga la entrada si la bandera está apagada, para cualquier rol", async () => {
    vi.stubEnv("COTIZACIONES", "");
    for (const role of ["owner", "admin", "agent"] as const) {
      h.role = role;
      expect(await layoutQuotesProp()).toBe(false);
    }
    h.isSuperadmin = true;
    expect(await layoutQuotesProp()).toBe(false);
  });

  it("con la bandera encendida, la entrada aparece para quien tiene quotes.read", async () => {
    vi.stubEnv("COTIZACIONES", "on");
    for (const role of ["owner", "admin", "agent"] as const) {
      h.role = role;
      expect(await layoutQuotesProp()).toBe(true);
    }
  });
});
