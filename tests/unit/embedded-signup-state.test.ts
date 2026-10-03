import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.DATABASE_URL = "postgresql://t:t@localhost:5432/t";
  process.env.BETTER_AUTH_SECRET = "secret-de-prueba-embedded-signup";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-test";
});

describe("correlación de Meta Embedded Signup", () => {
  it("acepta el state sólo para la misma sesión y organización", async () => {
    const { createEmbeddedSignupState, verifyEmbeddedSignupState } =
      await import("@/server/whatsapp/embedded-signup");
    const now = 1_800_000_000_000;
    const state = createEmbeddedSignupState({
      sessionId: "session_a",
      organizationId: "org_a",
      now,
    });

    expect(
      verifyEmbeddedSignupState({
        state,
        sessionId: "session_a",
        organizationId: "org_a",
        now,
      })
    ).toBe(true);
    expect(
      verifyEmbeddedSignupState({
        state,
        sessionId: "session_b",
        organizationId: "org_a",
        now,
      })
    ).toBe(false);
    expect(
      verifyEmbeddedSignupState({
        state,
        sessionId: "session_a",
        organizationId: "org_b",
        now,
      })
    ).toBe(false);
  });

  it("rechaza state alterado, vencido o emitido demasiado lejos en el futuro", async () => {
    const { createEmbeddedSignupState, verifyEmbeddedSignupState } =
      await import("@/server/whatsapp/embedded-signup");
    const now = 1_800_000_000_000;
    const state = createEmbeddedSignupState({
      sessionId: "session_a",
      organizationId: "org_a",
      now,
    });
    const altered = `${state.slice(0, -1)}${state.endsWith("a") ? "b" : "a"}`;

    expect(
      verifyEmbeddedSignupState({
        state: altered,
        sessionId: "session_a",
        organizationId: "org_a",
        now,
      })
    ).toBe(false);
    expect(
      verifyEmbeddedSignupState({
        state,
        sessionId: "session_a",
        organizationId: "org_a",
        now: now + 10 * 60 * 1000,
      })
    ).toBe(false);
    expect(
      verifyEmbeddedSignupState({
        state,
        sessionId: "session_a",
        organizationId: "org_a",
        now: now - 1,
      })
    ).toBe(false);
  });
});
