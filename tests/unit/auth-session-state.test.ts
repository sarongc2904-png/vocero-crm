import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

/**
 * AUTH-2 — Un usuario autenticado sin organización no puede quedar en el bucle
 * login → inbox → login.
 *
 * El bug: `getSessionOrNull()` devolvía `null` tanto para "sin sesión" como
 * para "sesión sin organización", y el layout de `(app)` mandaba ambos casos a
 * `/login`. Con credenciales correctas, la persona rebotaba sin ver jamás una
 * explicación.
 */

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string };
    session: { id: string; activeOrganizationId: string | null };
  },
  membership: null as null | {
    organizationId: string;
    role: string;
    usedFallback?: boolean;
  },
  suspended: false,
  fallback: null as null | { organizationId: string; role: string },
  membershipError: null as null | Error,
  setActiveOrganization: vi.fn(async () => undefined),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("@/lib/auth", () => ({
  getAuth: () => ({
    api: {
      getSession: async () => state.session,
      setActiveOrganization: state.setActiveOrganization,
    },
  }),
}));

vi.mock("@/lib/auth/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/permissions")>();
  return {
    ...actual,
    isConfiguredSuperadmin: () => false,
    hasOrganizationPermission: vi.fn(() => true),
  };
});

vi.mock("@/server/auth/organizations", () => ({
  organizationExists: async () => true,
  resolveActiveMembership: async () => {
    if (state.membershipError) throw state.membershipError;
    return state.membership;
  },
}));

vi.mock("@/server/auth/suspension", () => ({
  isMemberSuspended: async () => state.suspended,
  firstUnsuspendedMembership: async () => state.fallback,
}));

async function loadSession() {
  return await import("@/lib/auth/session");
}

beforeEach(() => {
  state.session = null;
  state.membership = null;
  state.suspended = false;
  state.fallback = null;
  state.membershipError = null;
  state.setActiveOrganization.mockClear();
});

describe("AUTH-2 · getSessionState", () => {
  it("sin sesión devuelve «anonymous» (esto sí va al login)", async () => {
    const { getSessionState } = await loadSession();

    expect(await getSessionState()).toEqual({ status: "anonymous" });
  });

  it("sesión sin ninguna organización devuelve «no_organization», no «anonymous»", async () => {
    state.session = {
      user: { id: "u1", email: "sin-org@example.com" },
      session: { id: "s1", activeOrganizationId: null },
    };
    const { getSessionState } = await loadSession();

    const result = await getSessionState();

    expect(result).toEqual({ status: "no_organization", reason: "no_membership" });
    // Lo importante: NO se confunde con "no autenticado".
    expect(result.status).not.toBe("anonymous");
  });

  it("membresía suspendida sin alternativa devuelve el motivo «suspended»", async () => {
    state.session = {
      user: { id: "u1", email: "suspendido@example.com" },
      session: { id: "s1", activeOrganizationId: "org-1" },
    };
    state.membership = { organizationId: "org-1", role: "agent" };
    state.suspended = true;
    state.fallback = null;
    const { getSessionState } = await loadSession();

    expect(await getSessionState()).toEqual({
      status: "no_organization",
      reason: "suspended",
    });
  });

  it("membresía suspendida con organización alternativa devuelve sesión utilizable", async () => {
    state.session = {
      user: { id: "u1", email: "miembro@example.com" },
      session: { id: "s1", activeOrganizationId: "org-1" },
    };
    state.membership = { organizationId: "org-1", role: "agent" };
    state.suspended = true;
    state.fallback = { organizationId: "org-2", role: "owner" };
    const { getSessionState } = await loadSession();

    const result = await getSessionState();

    expect(result.status).toBe("ok");
    expect(
      result.status === "ok" ? result.session.organizationId : null
    ).toBe("org-2");
    // Se reafija la organización activa en la sesión de better-auth.
    expect(state.setActiveOrganization).toHaveBeenCalledTimes(1);
  });

  it("membresía normal devuelve la sesión con su organización y rol", async () => {
    state.session = {
      user: { id: "u1", email: "miembro@example.com" },
      session: { id: "s1", activeOrganizationId: "org-1" },
    };
    state.membership = { organizationId: "org-1", role: "owner" };
    const { getSessionState } = await loadSession();

    const result = await getSessionState();

    expect(result).toEqual({
      status: "ok",
      session: {
        sessionId: "s1",
        userId: "u1",
        organizationId: "org-1",
        role: "owner",
        isSuperadmin: false,
      },
    });
  });

  it("una avería real NO se disfraza de «sin acceso»: el error sube", async () => {
    state.session = {
      user: { id: "u1", email: "miembro@example.com" },
      session: { id: "s1", activeOrganizationId: "org-1" },
    };
    state.membershipError = new Error("la base de datos no responde");
    const { getSessionState } = await loadSession();

    // Devolver "no_organization" aquí convertiría una caída en un bucle de
    // login silencioso, que es exactamente el bug que se está corrigiendo.
    await expect(getSessionState()).rejects.toThrow("la base de datos no responde");
  });
});

describe("AUTH-2 · layout de (app)", () => {
  async function loadLayout(sessionState: unknown) {
    vi.resetModules();
    const redirect = vi.fn((path: string) => {
      const error = new Error(`NEXT_REDIRECT:${path}`);
      (error as Error & { digest?: string }).digest = `NEXT_REDIRECT;${path}`;
      throw error;
    });

    vi.doMock("next/navigation", () => ({ redirect }));
    vi.doMock("next/headers", () => ({
      headers: async () => new Headers(),
      cookies: async () => ({ get: () => undefined }),
    }));
    vi.doMock("@/lib/auth/session", () => ({
      getSessionState: async () => sessionState,
    }));
    vi.doMock("@/server/commercial/entitlement", () => ({
      getCommercialAccess: async () => ({ allowed: true, status: "active" }),
    }));
    vi.doMock("@/server/branding", () => ({
      getBranding: async () => ({ name: "Prueba" }),
    }));
    vi.doMock("@/lib/auth", () => ({
      getAuth: () => ({ api: { getSession: async () => null } }),
    }));
    vi.doMock("@/lib/version", () => ({ resolveBuildCommit: () => "test" }));
    vi.doMock("@/server/agenda/flag", () => ({ agendaEnabled: () => false }));
    vi.doMock("@/components/app-shell", () => ({
      AppShell: ({ children }: { children: React.ReactNode }) => children,
    }));

    const layout = await import("@/app/(app)/layout");
    return { layout, redirect };
  }

  async function renderLayout(layout: {
    default: (props: Readonly<{ children: ReactNode }>) => Promise<unknown>;
  }) {
    try {
      await layout.default({ children: null });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }

  it("sin sesión va al login", async () => {
    const { layout } = await loadLayout({ status: "anonymous" });

    expect(await renderLayout(layout)).toContain("/login");
  });

  it("sin organización NO va al login: va a la pantalla explícita", async () => {
    const { layout } = await loadLayout({
      status: "no_organization",
      reason: "no_membership",
    });

    const destino = await renderLayout(layout);

    expect(destino).toContain("/organization-required");
    // El bucle existía justamente por esto:
    expect(destino).not.toContain("/login");
  });

  it("con sesión válida renderiza el CRM (sin redirección)", async () => {
    const { layout } = await loadLayout({
      status: "ok",
      session: {
        sessionId: "s1",
        userId: "u1",
        organizationId: "org-1",
        role: "owner",
        isSuperadmin: false,
      },
    });

    expect(await renderLayout(layout)).toBeNull();
  });
});
