import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Navegación: con COTIZACIONES apagada, el menú no muestra la entrada; el
 * layout del CRM decide con la bandera Y el permiso `quotes.read`.
 */

const h = vi.hoisted(() => ({
  role: "owner" as "owner" | "admin" | "agent",
  isSuperadmin: false,
  hasOrganizationPermission: vi.fn(() => true),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: h.redirect,
  usePathname: () => "/inbox",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/auth/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/permissions")>();
  return { ...actual, hasOrganizationPermission: h.hasOrganizationPermission };
});

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
  h.hasOrganizationPermission.mockReset();
  h.hasOrganizationPermission.mockReturnValue(true);
  h.redirect.mockClear();
});

async function layoutQuotesProp(): Promise<boolean> {
  const { default: AppLayout } = await import("@/app/(app)/layout");
  const element = (await AppLayout({ children: null })) as { props: { quotes?: boolean } };
  return Boolean(element.props.quotes);
}

async function quotesLinkFromLayout() {
  const { buildPrimaryNav } = await import("@/components/app-nav");
  const quotes = await layoutQuotesProp();
  return buildPrimaryNav({ agenda: false, quotes }).find(
    (item) => item.href === "/quotes"
  );
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

  it("con la bandera encendida y permiso concedido, renderiza el enlace sin redirección", async () => {
    vi.stubEnv("COTIZACIONES", "on");
    h.hasOrganizationPermission.mockReturnValue(true);

    expect(await quotesLinkFromLayout()).toEqual(
      expect.objectContaining({ href: "/quotes", label: "Cotizaciones" })
    );
    expect(h.hasOrganizationPermission).toHaveBeenCalledWith("owner", "quotes.read", {
      isSuperadmin: false,
    });
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it("con la bandera encendida y permiso negado, omite el enlace sin redirección", async () => {
    vi.stubEnv("COTIZACIONES", "on");
    h.hasOrganizationPermission.mockReturnValue(false);

    expect(await quotesLinkFromLayout()).toBeUndefined();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it("si falla el cálculo del permiso, conserva el CRM y omite el enlace", async () => {
    vi.stubEnv("COTIZACIONES", "on");
    h.hasOrganizationPermission.mockImplementation(() => {
      throw new Error("permission backend unavailable");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await quotesLinkFromLayout()).toBeUndefined();
    expect(h.redirect).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "[cotizaciones] no se pudo calcular el permiso de navegación:",
      expect.any(Error)
    );

    consoleError.mockRestore();
  });
});
