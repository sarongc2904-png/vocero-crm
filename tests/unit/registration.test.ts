import { afterEach, describe, expect, it, vi } from "vitest";

/** FR-060/FR-081: registro cerrado tras la 1ª organización, salvo escape. */

let orgCount = 0;

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => Promise.resolve([{ n: orgCount }]),
    }),
  }),
  schema: { organization: {} },
}));

import { isPublicSignupAllowed } from "@/server/auth/registration";

afterEach(() => vi.unstubAllEnvs());

describe("registro público cerrado", () => {
  it("instancia vacía → registro permitido (primer usuario)", async () => {
    orgCount = 0;
    vi.stubEnv("ALLOW_SIGNUP", "");
    vi.stubEnv("PUBLIC_SIGNUP", "");
    expect(await isPublicSignupAllowed()).toBe(true);
  });

  it("ya existe una organización → cerrado", async () => {
    orgCount = 1;
    vi.stubEnv("ALLOW_SIGNUP", "");
    vi.stubEnv("PUBLIC_SIGNUP", "");
    expect(await isPublicSignupAllowed()).toBe(false);
  });

  it("escape ALLOW_SIGNUP=true → permitido aunque exista organización", async () => {
    orgCount = 1;
    vi.stubEnv("ALLOW_SIGNUP", "true");
    vi.stubEnv("PUBLIC_SIGNUP", "");
    expect(await isPublicSignupAllowed()).toBe(true);
  });

  it("otros valores del escape NO abren el registro", async () => {
    orgCount = 1;
    vi.stubEnv("ALLOW_SIGNUP", "1");
    vi.stubEnv("PUBLIC_SIGNUP", "");
    expect(await isPublicSignupAllowed()).toBe(false);
  });

  it("PUBLIC_SIGNUP=open abre el registro aunque exista organización", async () => {
    orgCount = 2;
    vi.stubEnv("PUBLIC_SIGNUP", "open");
    vi.stubEnv("ALLOW_SIGNUP", "");
    expect(await isPublicSignupAllowed()).toBe(true);
  });

  it("PUBLIC_SIGNUP=closed prevalece sobre el escape legacy", async () => {
    orgCount = 2;
    vi.stubEnv("PUBLIC_SIGNUP", "closed");
    vi.stubEnv("ALLOW_SIGNUP", "true");
    expect(await isPublicSignupAllowed()).toBe(false);
  });
});
