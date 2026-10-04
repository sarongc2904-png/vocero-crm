import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class CredentialsOwnershipError extends Error {}
  class EmbeddedSignupError extends Error {}
  return {
    CredentialsOwnershipError,
    EmbeddedSignupError,
    session: null as null | {
      sessionId: string;
      userId: string;
      organizationId: string;
      role: "owner";
      isSuperadmin: false;
    },
    credentials: new Map<string, Record<string, unknown>>(),
    phoneOwners: new Map<string, string>(),
    audits: [] as unknown[],
    graphSignals: [] as unknown[],
    extensionCalls: 0,
    validState: true,
    metaFailure: false,
    extensionFailure: false,
    registrationResult: { status: "registered" } as
      | { status: "registered" }
      | { status: "pending"; code: "phone_verification_pending" }
      | {
          status: "failed";
          code:
            | "phone_registration_failed"
            | "registration_pin_invalid"
            | "registration_attempts_exceeded"
            | "meta_unavailable"
            | "meta_timeout";
        },
    phoneBelongsToWaba: true,
    wabaCheckFailure: false,
    wabaAbort: false,
    subscriptionSucceeds: true,
    connectionCheck: {
      ok: true as boolean,
      displayPhoneNumber: "+52 55 0000 0000",
      verifiedName: "Negocio de prueba",
    } as
      | { ok: true; displayPhoneNumber: string; verifiedName: string }
      | {
          ok: false;
          code: "invalid_token" | "meta_unavailable" | "meta_timeout" | "meta_error";
          message: string;
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
      handler: (
        session: NonNullable<typeof h.session>,
        ...args: unknown[]
      ) => Promise<Response>
    ) =>
    async (...args: unknown[]) => {
      if (!h.session) {
        return Response.json(
          { error: { code: "no_membership", message: "Sin organización" } },
          { status: 403 }
        );
      }
      return handler(h.session, ...args);
    },
}));

vi.mock("@/lib/env", () => ({
  isEmbeddedSignupConfigured: () => true,
}));

vi.mock("@/server/auth/audit", () => ({
  auditPrivilegedAction: vi.fn(async (_session, event) => {
    h.audits.push(event);
  }),
}));

vi.mock("@/server/whatsapp/credentials", () => ({
  CredentialsOwnershipError: h.CredentialsOwnershipError,
  assertPhoneNumberAvailableForOrg: vi.fn(
    async (organizationId: string, phoneNumberId: string) => {
      const owner = h.phoneOwners.get(phoneNumberId);
      if (owner && owner !== organizationId) {
        throw new h.CredentialsOwnershipError();
      }
    }
  ),
  saveCredentials: vi.fn(async (input: Record<string, unknown>) => {
    const organizationId = String(input.organizationId);
    const old = h.credentials.get(organizationId);
    if (old?.phoneNumberId) h.phoneOwners.delete(String(old.phoneNumberId));
    h.credentials.set(organizationId, {
      ...input,
      id: `cred_${organizationId}`,
      status: "connected",
    });
    h.phoneOwners.set(String(input.phoneNumberId), organizationId);
  }),
  getCredentialsByOrg: vi.fn(async (organizationId: string) =>
    h.credentials.get(organizationId) ?? null
  ),
  markReconnectRequired: vi.fn(async (organizationId: string) => {
    const row = h.credentials.get(organizationId);
    if (row) row.status = "reconnect_required";
  }),
  deleteCredentialsByOrg: vi.fn(async (organizationId: string) => {
    const row = h.credentials.get(organizationId);
    if (row?.phoneNumberId) h.phoneOwners.delete(String(row.phoneNumberId));
    h.credentials.delete(organizationId);
  }),
}));

vi.mock("@/server/whatsapp/connect", () => ({
  testConnection: vi.fn(async (_phoneNumberId, _token, signal) => {
    h.graphSignals.push(signal);
    return h.connectionCheck;
  }),
  subscribeAppToWaba: vi.fn(async (_wabaId, _token, signal) => {
    h.graphSignals.push(signal);
    return h.subscriptionSucceeds;
  }),
}));

vi.mock("@/server/whatsapp/embedded-signup", () => ({
  EmbeddedSignupError: h.EmbeddedSignupError,
  verifyEmbeddedSignupState: vi.fn(() => h.validState),
  createEmbeddedSignupState: vi.fn(
    ({ organizationId }: { organizationId: string }) => `state-${organizationId}`
  ),
  exchangeCodeForToken: vi.fn(async (_code, signal) => {
    h.graphSignals.push(signal);
    if (h.metaFailure) throw new h.EmbeddedSignupError("Meta rechazó el código");
    return "token-super-secreto";
  }),
  extendToken: vi.fn(async () => {
    h.extensionCalls += 1;
    if (h.extensionFailure) {
      throw new h.EmbeddedSignupError(
        "texto crudo privado de Meta token-super-secreto code_ok"
      );
    }
    return "token-largo-super-secreto";
  }),
  registerPhoneNumberIfNeeded: vi.fn(async (_phoneNumberId, _token, signal) => {
    h.graphSignals.push(signal);
    return h.registrationResult;
  }),
  verifyPhoneNumberBelongsToWaba: vi.fn(async (_wabaId, _phoneNumberId, _token, signal) => {
    h.graphSignals.push(signal);
    if (h.wabaAbort) {
      throw new DOMException("texto crudo privado de timeout", "AbortError");
    }
    if (h.wabaCheckFailure) throw new Error("texto crudo privado de Graph");
    return h.phoneBelongsToWaba;
  }),
}));

import { POST as completeEmbeddedSignup } from "@/app/api/settings/whatsapp/embedded-signup/route";
import {
  DELETE as disconnectWhatsapp,
  GET as getWhatsapp,
} from "@/app/api/settings/whatsapp/route";

function session(organizationId: string) {
  h.session = {
    sessionId: `session_${organizationId}`,
    userId: `user_${organizationId}`,
    organizationId,
    role: "owner",
    isSuperadmin: false,
  };
}

function signupRequest(phoneNumberId = "pn_a", code = "code_ok") {
  return new Request("http://localhost/api/settings/whatsapp/embedded-signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      state: "state-firmado",
      wabaId: "waba_a",
      phoneNumberId,
    }),
  });
}

beforeEach(() => {
  h.session = null;
  h.credentials.clear();
  h.phoneOwners.clear();
  h.audits.length = 0;
  h.graphSignals.length = 0;
  h.extensionCalls = 0;
  h.validState = true;
  h.metaFailure = false;
  h.extensionFailure = false;
  h.registrationResult = { status: "registered" };
  h.phoneBelongsToWaba = true;
  h.wabaCheckFailure = false;
  h.wabaAbort = false;
  h.subscriptionSucceeds = true;
  h.connectionCheck = {
    ok: true,
    displayPhoneNumber: "+52 55 0000 0000",
    verifiedName: "Negocio de prueba",
  };
});

describe("Meta Embedded Signup — contrato MVP multi-tenant", () => {
  it("guarda la conexión exclusivamente en la organización activa", async () => {
    session("org_a");
    const response = await completeEmbeddedSignup(signupRequest());

    expect(response.status).toBe(200);
    expect(h.credentials.get("org_a")).toMatchObject({
      organizationId: "org_a",
      phoneNumberId: "pn_a",
      status: "connected",
      token: "token-super-secreto",
    });
    expect(h.credentials.has("org_b")).toBe(false);
    expect(h.extensionCalls).toBe(0);
    expect(h.graphSignals).toHaveLength(5);
    for (const signal of h.graphSignals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("otro tenant no puede leer ni sobrescribir la conexión existente", async () => {
    session("org_a");
    await completeEmbeddedSignup(signupRequest());

    session("org_b");
    const read = await getWhatsapp();
    expect((await read.json()).connection).toBeNull();

    const overwrite = await completeEmbeddedSignup(signupRequest());
    expect(overwrite.status).toBe(409);
    expect(h.credentials.get("org_a")).toMatchObject({ phoneNumberId: "pn_a" });
    expect(h.credentials.has("org_b")).toBe(false);
  });

  it("rechaza falta de organización activa y callback inválido sin persistir", async () => {
    expect((await completeEmbeddedSignup(signupRequest())).status).toBe(403);
    session("org_a");
    h.validState = false;
    expect((await completeEmbeddedSignup(signupRequest())).status).toBe(422);
    expect(h.credentials.size).toBe(0);
  });

  it("un error de Meta no persiste conexión", async () => {
    session("org_a");
    h.metaFailure = true;
    const response = await completeEmbeddedSignup(signupRequest());

    expect(response.status).toBe(422);
    expect(h.credentials.size).toBe(0);
  });

  it("no ejecuta una segunda extensión aunque esa operación fallaría", async () => {
    session("org_a");
    h.extensionFailure = true;

    const response = await completeEmbeddedSignup(signupRequest());

    expect(response.status).toBe(200);
    expect(h.extensionCalls).toBe(0);
    expect(h.credentials.get("org_a")).toMatchObject({
      token: "token-super-secreto",
      status: "connected",
    });
  });

  it.each([
    [{ status: "pending", code: "phone_verification_pending" } as const, "phone_verification_pending"],
    [{ status: "failed", code: "registration_pin_invalid" } as const, "registration_pin_invalid"],
    [{ status: "failed", code: "registration_attempts_exceeded" } as const, "registration_attempts_exceeded"],
    [{ status: "failed", code: "phone_registration_failed" } as const, "phone_registration_failed"],
    [{ status: "failed", code: "meta_unavailable" } as const, "meta_unavailable"],
    [{ status: "failed", code: "meta_timeout" } as const, "meta_timeout"],
  ])("ningun resultado de registro distinto de registrado guarda connected", async (result, code) => {
    session("org_a");
    h.registrationResult = result;

    const response = await completeEmbeddedSignup(signupRequest());

    expect(response.status).not.toBe(200);
    expect((await response.json()).error.code).toBe(code);
    expect(h.credentials.size).toBe(0);
  });

  it("un fallo de /register no suscribe, guarda ni deja auditoria parcial", async () => {
    session("org_a");
    h.registrationResult = {
      status: "failed",
      code: "phone_registration_failed",
    };

    const response = await completeEmbeddedSignup(signupRequest());

    expect(response.status).toBe(422);
    expect(h.graphSignals).toHaveLength(4);
    expect(h.credentials.size).toBe(0);
    expect(h.audits).toHaveLength(0);
  });

  it.each([
    [
      "registration_pin_invalid" as const,
      "Meta rechazó el PIN de verificación. Restablécelo en WhatsApp Manager antes de intentar nuevamente.",
    ],
    [
      "registration_attempts_exceeded" as const,
      "Meta bloqueó temporalmente nuevos intentos de registro. Espera antes de intentar nuevamente.",
    ],
  ])("devuelve mensaje fijo distinto para %s", async (code, message) => {
    session("org_a");
    h.registrationResult = { status: "failed", code };

    const response = await completeEmbeddedSignup(signupRequest());

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { code, message } });
    expect(h.credentials.size).toBe(0);
  });

  it("rechaza un phoneNumberId que no pertenece a la WABA antes de guardar", async () => {
    session("org_a");
    h.phoneBelongsToWaba = false;

    const response = await completeEmbeddedSignup(signupRequest());

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("phone_waba_mismatch");
    expect(h.credentials.size).toBe(0);
  });

  it("rechaza un fallo de Graph al comprobar WABA sin filtrar texto crudo", async () => {
    session("org_a");
    h.wabaCheckFailure = true;

    const response = await completeEmbeddedSignup(signupRequest("pn_a", "code_privado"));
    const responseText = await response.text();

    expect(response.status).toBe(503);
    expect(responseText).toContain('"code":"phone_waba_check_failed"');
    expect(responseText).not.toContain("texto crudo privado de Graph");
    expect(responseText).not.toContain("code_privado");
    expect(h.credentials.size).toBe(0);
  });

  it("responde meta_timeout fijo si Graph se aborta", async () => {
    session("org_a");
    h.wabaAbort = true;

    const response = await completeEmbeddedSignup(signupRequest());
    const responseText = await response.text();

    expect(response.status).toBe(503);
    expect(responseText).toContain('"code":"meta_timeout"');
    expect(responseText).toContain("Meta tardó demasiado en responder. Intenta nuevamente.");
    expect(responseText).not.toContain("texto crudo privado de timeout");
    expect(h.credentials.size).toBe(0);
  });

  it("no declara connected si Meta no confirma la suscripción del webhook", async () => {
    session("org_a");
    h.subscriptionSucceeds = false;
    const response = await completeEmbeddedSignup(signupRequest());

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe(
      "webhook_subscription_failed"
    );
    expect(h.credentials.size).toBe(0);
  });

  it("reconecta de forma idempotente el mismo tenant", async () => {
    session("org_a");
    expect((await completeEmbeddedSignup(signupRequest())).status).toBe(200);
    expect((await completeEmbeddedSignup(signupRequest())).status).toBe(200);

    expect(h.credentials.size).toBe(1);
    expect(h.credentials.get("org_a")).toMatchObject({ status: "connected" });
  });

  it("GET refleja connected o reauth y nunca devuelve secretos", async () => {
    session("org_a");
    await completeEmbeddedSignup(signupRequest());

    const connected = await getWhatsapp();
    const connectedText = await connected.text();
    expect(connectedText).toContain('"status":"connected"');
    expect(connectedText).not.toContain("token-super-secreto");
    expect(connectedText).not.toContain("token-largo-super-secreto");

    h.connectionCheck = {
      ok: false,
      code: "invalid_token",
      message: "token vencido",
    };
    const expired = await getWhatsapp();
    expect((await expired.json()).connection.status).toBe("reconnect_required");
  });

  it("un fallo transitorio de Meta se muestra como error sin borrar credenciales", async () => {
    session("org_a");
    await completeEmbeddedSignup(signupRequest());
    h.connectionCheck = {
      ok: false,
      code: "meta_unavailable",
      message: "Meta no disponible",
    };

    const response = await getWhatsapp();
    const body = await response.json();
    expect(body.connection.status).toBe("error");
    expect(body.connection.errorMessage).toMatch(/verificar la conexión/i);
    expect(h.credentials.has("org_a")).toBe(true);
  });

  it("audita sin token y desconecta sólo el tenant activo", async () => {
    session("org_a");
    await completeEmbeddedSignup(signupRequest());
    const auditText = JSON.stringify(h.audits);
    expect(auditText).not.toContain("token-super-secreto");
    expect(auditText).not.toContain("token-largo-super-secreto");
    expect(auditText).toContain("waba_a");
    expect(auditText).toContain("pn_a");
    expect(auditText).not.toContain("code_ok");

    session("org_b");
    h.credentials.set("org_b", {
      organizationId: "org_b",
      phoneNumberId: "pn_b",
      token: "token_b",
      status: "connected",
    });
    await disconnectWhatsapp();
    expect(h.credentials.has("org_b")).toBe(false);
    expect(h.credentials.has("org_a")).toBe(true);
  });
});
