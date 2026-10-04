import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  graphRequest: vi.fn(),
  env: {
    APP_BASE_URL: "http://localhost:3000",
    DATABASE_URL: "postgresql://t:t@localhost:5432/t",
    BETTER_AUTH_SECRET: "secret-de-prueba-embedded-signup",
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    META_WEBHOOK_VERIFY_TOKEN: "verify-test",
    META_APP_ID: "app-id",
    META_APP_SECRET: "app-secret",
    META_GRAPH_API_VERSION: "v25.0",
    META_GRAPH_BASE_URL: "https://graph.facebook.com",
  } as Record<string, string | undefined>,
}));

vi.mock("@/lib/env", () => ({ getEnv: () => h.env }));

vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return {
    ...original,
    graphRequest: (...args: unknown[]) => h.graphRequest(...args),
  };
});

import { MetaApiError } from "@/lib/meta/client";
import {
  extendToken,
  registerPhoneNumberIfNeeded,
  verifyPhoneNumberBelongsToWaba,
} from "@/server/whatsapp/embedded-signup";

const TOKEN = "token-super-secreto";
const OAUTH_CODE = "codigo-oauth-super-secreto";
const RAW_META_TEXT = "texto crudo privado de Meta";

function metaError(status: number, code: number | null, subcode = 0) {
  return new MetaApiError(RAW_META_TEXT, {
    status,
    code,
    details: {
      error: {
        message: RAW_META_TEXT,
        code,
        error_subcode: subcode,
        fbtrace_id: "AbC_123-safe",
      },
    },
  });
}

beforeEach(() => {
  h.graphRequest.mockReset();
  h.env.META_APP_ID = "app-id";
  h.env.META_APP_SECRET = "app-secret";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("clasificacion cerrada del registro de numero", () => {
  it("clasifica el 200 documentado como registrado, tambien al reintentar", async () => {
    h.graphRequest.mockResolvedValue({ success: true });

    await expect(registerPhoneNumberIfNeeded("pn_1", TOKEN)).resolves.toEqual({
      status: "registered",
    });
    await expect(registerPhoneNumberIfNeeded("pn_1", TOKEN)).resolves.toEqual({
      status: "registered",
    });
  });

  it("clasifica 133006 como verificacion pendiente de forma explicita", async () => {
    h.graphRequest.mockRejectedValue(metaError(400, 133006, 2388001));

    await expect(registerPhoneNumberIfNeeded("pn_1", TOKEN)).resolves.toEqual({
      status: "pending",
      code: "phone_verification_pending",
    });
  });

  it("trata cualquier otro 4xx como fallo con codigo estable", async () => {
    h.graphRequest.mockRejectedValue(metaError(400, 999999, 123));

    await expect(registerPhoneNumberIfNeeded("pn_1", TOKEN)).resolves.toEqual({
      status: "failed",
      code: "phone_registration_failed",
    });
  });

  it.each([
    ["5xx", metaError(503, 2)],
    ["red", new MetaApiError(RAW_META_TEXT, { status: 0, details: new Error(RAW_META_TEXT) })],
  ])("trata %s como fallo, nunca como exito", async (_case, error) => {
    h.graphRequest.mockRejectedValue(error);

    await expect(registerPhoneNumberIfNeeded("pn_1", TOKEN)).resolves.toEqual({
      status: "failed",
      code: "meta_unavailable",
    });
  });

  it("no filtra token, texto crudo ni identificadores sin validar en logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.graphRequest.mockRejectedValue(
      new MetaApiError(`${RAW_META_TEXT} ${TOKEN} ${OAUTH_CODE}`, {
        status: 400,
        code: 999999,
        details: {
          error: {
            message: `${RAW_META_TEXT} ${TOKEN} ${OAUTH_CODE}`,
            error_subcode: "123;token-super-secreto",
            fbtrace_id: "trace con espacios token-super-secreto",
          },
        },
      })
    );

    await registerPhoneNumberIfNeeded("pn_1", TOKEN);

    const output = JSON.stringify(warn.mock.calls);
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(OAUTH_CODE);
    expect(output).not.toContain(RAW_META_TEXT);
    expect(output).not.toContain("trace con espacios");
  });
});

describe("extension obligatoria del token", () => {
  it("falla cerrado si falta META_APP_ID y no devuelve el token corto", async () => {
    delete h.env.META_APP_ID;

    await expect(extendToken(TOKEN)).rejects.toThrow(
      "No pudimos completar la conexión segura con Meta"
    );
  });

  it.each([
    ["respuesta no ok", async () => new Response(RAW_META_TEXT, { status: 400 })],
    ["excepcion", async () => Promise.reject(new Error(`${RAW_META_TEXT} ${TOKEN}`))],
    ["access_token ausente", async () => Response.json({ expires_in: 3600 })],
  ])("falla cerrado ante %s y no usa el token corto", async (_case, fetchImpl) => {
    vi.stubGlobal("fetch", vi.fn(fetchImpl));

    await expect(extendToken(TOKEN)).rejects.toThrow(
      "No pudimos completar la conexión segura con Meta"
    );
  });
});

describe("pertenencia phoneNumberId a WABA", () => {
  it("rechaza un numero que no aparece en la lista completa", async () => {
    h.graphRequest.mockResolvedValue({ data: [{ id: "pn_otro" }] });

    await expect(
      verifyPhoneNumberBelongsToWaba("waba_1", "pn_1", TOKEN)
    ).resolves.toBe(false);
  });

  it("recorre la paginacion y acepta el numero encontrado en pagina 2", async () => {
    h.graphRequest
      .mockResolvedValueOnce({
        data: [{ id: "pn_otro" }],
        paging: { cursors: { after: "cursor-seguro" }, next: "https://example.invalid/page2" },
      })
      .mockResolvedValueOnce({ data: [{ id: "pn_1" }] });

    await expect(
      verifyPhoneNumberBelongsToWaba("waba_1", "pn_1", TOKEN)
    ).resolves.toBe(true);
    expect(h.graphRequest).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("after=cursor-seguro"),
      { token: TOKEN }
    );
  });

  it("rechaza si Graph falla y no filtra el error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.graphRequest.mockRejectedValue(metaError(503, 2));

    await expect(
      verifyPhoneNumberBelongsToWaba("waba_1", "pn_1", TOKEN)
    ).rejects.toThrow("No pudimos verificar el número con Meta");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(RAW_META_TEXT);
  });
});
