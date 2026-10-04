import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class CredentialsOwnershipError extends Error {}
  return {
    CredentialsOwnershipError,
    saved: [] as unknown[],
    session: {
      sessionId: "session_org_a",
      userId: "user_org_a",
      organizationId: "org_a",
      role: "owner" as const,
      isSuperadmin: false as const,
    },
  };
});

vi.mock("@/lib/api", () => ({
  apiError: (status: number, code: string, message: string) =>
    Response.json({ error: { code, message } }, { status }),
  parseBody: async (
    req: Request,
    schema: {
      safeParse: (
        value: unknown
      ) => { success: true; data: unknown } | { success: false };
    }
  ) => {
    const parsed = schema.safeParse(await req.json());
    return parsed.success
      ? { ok: true, data: parsed.data }
      : {
          ok: false,
          response: Response.json(
            { error: { code: "invalid_body", message: "Body inválido" } },
            { status: 422 }
          ),
        };
  },
  withOrgPermissions:
    (
      _permissions: string[],
      handler: (session: typeof h.session, req: Request) => Promise<Response>
    ) =>
    (req: Request) =>
      handler(h.session, req),
}));

vi.mock("@/server/auth/audit", () => ({
  auditPrivilegedAction: vi.fn(),
}));

vi.mock("@/server/whatsapp/credentials", () => ({
  CredentialsOwnershipError: h.CredentialsOwnershipError,
  assertPhoneNumberAvailableForOrg: vi.fn(),
  saveCredentials: vi.fn(async (input: unknown) => {
    h.saved.push(input);
  }),
}));

import { POST } from "@/app/api/settings/whatsapp/embedded-signup/route";
import { createEmbeddedSignupState } from "@/server/whatsapp/embedded-signup";

const realTimeout = AbortSignal.timeout.bind(AbortSignal);
const RAW_TIMEOUT_TEXT = "texto crudo privado de timeout token-super-secreto";

function request(): Request {
  return new Request("http://localhost/api/settings/whatsapp/embedded-signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: "code-super-secreto",
      state: createEmbeddedSignupState({
        sessionId: h.session.sessionId,
        organizationId: h.session.organizationId,
      }),
      wabaId: "waba_a",
      phoneNumberId: "pn_a",
    }),
  });
}

function successResponse(callIndex: number): Response {
  if (callIndex === 0) return Response.json({ access_token: "token-super-secreto" });
  if (callIndex === 1) return Response.json({ data: [{ id: "pn_a" }] });
  if (callIndex === 2) {
    return Response.json({
      id: "pn_a",
      display_phone_number: "+52 55 0000 0000",
      verified_name: "Negocio",
    });
  }
  if (callIndex === 3) {
    return Response.json({
      status: "CONNECTED",
      code_verification_status: "VERIFIED",
    });
  }
  return Response.json({ success: true });
}

function neverRespond(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (!signal) return reject(new Error("signal ausente"));
    const rejectWithReason = () => reject(signal.reason ?? new Error(RAW_TIMEOUT_TEXT));
    if (signal.aborted) return rejectWithReason();
    signal.addEventListener("abort", rejectWithReason, { once: true });
  });
}

beforeEach(() => {
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.DATABASE_URL = "postgresql://t:t@localhost:5432/t";
  process.env.BETTER_AUTH_SECRET = "secret-de-prueba-real-timeout";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-test";
  process.env.META_APP_ID = "app-id";
  process.env.META_APP_SECRET = "app-secret";
  process.env.META_EMBEDDED_SIGNUP_CONFIG_ID = "config-id";
  process.env.META_GRAPH_BASE_URL = "https://graph.facebook.com";
  process.env.META_GRAPH_API_VERSION = "v25.0";
  h.saved.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(10));
});

describe("timeouts reales durante Embedded Signup", () => {
  it.each([
    ["intercambio", 0],
    ["verificacion WABA", 1],
    ["testConnection", 2],
    ["registro", 3],
    ["suscripcion", 4],
  ] as const)("rechaza %s con meta_timeout fijo y sin guardar", async (_step, timeoutAt) => {
    let callIndex = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        const current = callIndex++;
        return current === timeoutAt
          ? neverRespond(init?.signal)
          : Promise.resolve(successResponse(current));
      })
    );

    const response = await POST(request());
    const responseText = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(responseText)).toEqual({
      error: {
        code: "meta_timeout",
        message: "Meta tardó demasiado en responder. Intenta nuevamente.",
      },
    });
    expect(responseText).not.toContain(RAW_TIMEOUT_TEXT);
    expect(responseText).not.toContain("token-super-secreto");
    expect(responseText).not.toContain("code-super-secreto");
    expect(h.saved).toHaveLength(0);
  });
});
