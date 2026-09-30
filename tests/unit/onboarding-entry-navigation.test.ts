import { describe, expect, it, vi } from "vitest";

type SessionState =
  | { status: "anonymous" }
  | { status: "no_organization"; reason: "no_membership" }
  | {
      status: "ok";
      session: {
        sessionId: string;
        userId: string;
        organizationId: string;
        role: "owner" | "admin" | "agent";
        isSuperadmin: boolean;
      };
    };

async function resolveHome(input: {
  state: SessionState;
  activated?: boolean;
}) {
  vi.resetModules();
  const redirect = vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  });
  const getOnboardingState = vi.fn(async () => ({
    steps: [
      {
        id: "activation",
        complete: Boolean(input.activated),
        label: "Listo para operar",
        href: "/onboarding",
      },
    ],
  }));

  vi.doMock("next/navigation", () => ({ redirect }));
  vi.doMock("@/lib/auth/session", () => ({
    getSessionState: async () => input.state,
  }));
  vi.doMock("@/server/commercial/onboarding", () => ({
    getOnboardingState,
  }));

  const { default: Home } = await import("@/app/page");
  let destination: string | null = null;
  try {
    await Home();
  } catch (error) {
    destination = (error as Error).message.replace("NEXT_REDIRECT:", "");
  }

  return { destination, getOnboardingState };
}

const session = (
  role: "owner" | "admin" | "agent",
  isSuperadmin = false
): SessionState => ({
  status: "ok",
  session: {
    sessionId: "session-1",
    userId: "user-1",
    organizationId: "org-session",
    role,
    isSuperadmin,
  },
});

describe("navegación inicial del onboarding", () => {
  it("envía sesión anónima al login", async () => {
    expect((await resolveHome({ state: { status: "anonymous" } })).destination).toBe("/login");
  });

  it("envía sesión sin organización a la explicación correcta", async () => {
    const result = await resolveHome({
      state: { status: "no_organization", reason: "no_membership" },
    });
    expect(result.destination).toBe("/organization-required");
  });

  it("no atrapa agentes ni superadmin en onboarding", async () => {
    const agent = await resolveHome({ state: session("agent") });
    const superadmin = await resolveHome({ state: session("owner", true) });

    expect(agent.destination).toBe("/inbox");
    expect(superadmin.destination).toBe("/inbox");
    expect(agent.getOnboardingState).not.toHaveBeenCalled();
    expect(superadmin.getOnboardingState).not.toHaveBeenCalled();
  });

  it("envía owner y admin incompletos al onboarding usando su organización", async () => {
    const owner = await resolveHome({ state: session("owner"), activated: false });
    const admin = await resolveHome({ state: session("admin"), activated: false });

    expect(owner.destination).toBe("/onboarding");
    expect(admin.destination).toBe("/onboarding");
    expect(owner.getOnboardingState).toHaveBeenCalledWith("org-session");
    expect(admin.getOnboardingState).toHaveBeenCalledWith("org-session");
  });

  it("mantiene owner y admin activados en mensajes", async () => {
    expect(
      (await resolveHome({ state: session("owner"), activated: true })).destination
    ).toBe("/inbox");
    expect(
      (await resolveHome({ state: session("admin"), activated: true })).destination
    ).toBe("/inbox");
  });
});
