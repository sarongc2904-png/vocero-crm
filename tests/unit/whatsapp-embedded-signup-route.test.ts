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
    validState: true,
    metaFailure: false,
    extensionFailure: false,
    registrationResult: { status: "registered" } as
      | { status: "registered" }
      | { status: "pending"; code: "phone_verification_pending" }
      | { status: "failed"; code: "phone_registration_failed" | "meta_unavailable" },
    phoneBelongsToWaba: true,
    wabaCheckFailure: false,
    subscriptionSucceeds: true,
    connectionCheck: {
      ok: true as boolean,
      displayPhoneNumber: "+52 55 0000 0000",
      verifiedName: "Negocio de prueba",
    } as
      | { ok: true; displayPhoneNumber: string; verifiedName: string }
      | {
          ok: false;
          code: "invalid_token" | "meta_unavailable" | "meta_error";
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
  testConnection: vi.fn(async () => h.connectionCheck),
  subscribeAppToWaba: vi.fn(async () => h.subscriptionSucceeds),
}));

vi.mock("@/server/whatsapp/embedded-signup", () => ({
  EmbeddedSignupError: h.EmbeddedSignupError,
  verifyEmbeddedSignupState: vi.fn(() => h.validState),
  createEmbeddedSignupState: vi.fn(
    ({ organizationId }: { organizationId: string }) => `state-${organizationId}`
  ),
  exchangeCodeForToken: vi.fn(async () => {
    if (h.metaFailure) throw new h.EmbeddedSignupError("Meta rechazó el código");
    return "token-super-secreto";
  }),
  extendToken: vi.fn(async () => {
    if (h.extensionFailure) {
      throw new h.EmbeddedSignupError(
        "texto crudo privado de Meta token-super-secreto code_ok"
      );
    }
    return "token-largo-super-secreto";
  }),
  registerPhoneNumberIfNeeded: vi.fn(async () => h.registrationResult),
  verifyPhoneNumberBelongsToWaba: vi.fn(async () => {
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
  h.validState = true;
  h.metaFailure = false;
  h.extensionFailure = false;
  h.registrationResult = { status: "registered" };
  h.phoneBelongsToWaba = true;
  h.wabaCheckFailure = false;
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
    });
    expect(h.credentials.has("org_b")).toBe(false);
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

  it("un fallo al extender el token responde fijo y no persiste el token corto", async () => {
    session("org_a");
    h.extensionFailure = true;

    const response = await completeEmbeddedSignup(signupRequest());
    const responseText = await response.text();

    expect(response.status).toBe(422);
    expect(responseText).toContain('"code":"token_extension_failed"');
    expect(responseText).toContain(
      "No pudimos completar la conexión segura con Meta. Intenta nuevamente."
    );
    expect(responseText).not.toContain("token-super-secreto");
    expect(responseText).not.toContain("code_ok");
    expect(responseText).not.toContain("texto crudo privado de Meta");
    expect(h.credentials.size).toBe(0);
  });

  it.each([
    [{ status: "pending", code: "phone_verification_pending" } as const, "phone_verification_pending"],
    [{ status: "failed", code: "phone_registration_failed" } as const, "phone_registration_failed"],
    [{ status: "failed", code: "meta_unavailable" } as const, "meta_unavailable"],
  ])("ningun resultado de registro distinto de registrado guarda connected", async (result, code) => {
    session("org_a");
    h.registrationResult = result;

    const response = await completeEmbeddedSignup(signupRequest());

    expect(response.status).not.toBe(200);
    expect((await response.json()).error.code).toBe(code);
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
    expect(auditText).not.toContain("waba_a");
    expect(auditText).not.toContain("pn_a");
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
