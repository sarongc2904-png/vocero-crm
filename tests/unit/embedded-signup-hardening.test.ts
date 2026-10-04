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
  exchangeCodeForToken,
  registerPhoneNumberIfNeeded,
  verifyPhoneNumberBelongsToWaba,
} from "@/server/whatsapp/embedded-signup";

const TOKEN = "token-super-secreto";
const OAUTH_CODE = "codigo-oauth-super-secreto";
const RAW_META_TEXT = "texto crudo privado de Meta";
const SIGNAL = new AbortController().signal;

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
  it("omite /register si el estado oficial ya es CONNECTED", async () => {
    h.graphRequest.mockResolvedValue({
      status: "CONNECTED",
      code_verification_status: "VERIFIED",
    });

    await expect(
      registerPhoneNumberIfNeeded("pn_1", TOKEN, SIGNAL)
    ).resolves.toEqual({ status: "registered" });
    expect(h.graphRequest).toHaveBeenCalledExactlyOnceWith(
      "pn_1?fields=status,code_verification_status",
      { token: TOKEN, signal: SIGNAL }
    );
  });

  it("consulta estado y registra solo un numero verificado no conectado", async () => {
    h.graphRequest
      .mockResolvedValueOnce({
        status: "DISCONNECTED",
        code_verification_status: "VERIFIED",
      })
      .mockResolvedValueOnce({ success: true });

    await expect(registerPhoneNumberIfNeeded("pn_1", TOKEN, SIGNAL)).resolves.toEqual({
      status: "registered",
    });
    expect(h.graphRequest).toHaveBeenNthCalledWith(
      2,
      "pn_1/register",
      expect.objectContaining({ method: "POST", token: TOKEN, signal: SIGNAL })
    );
  });

  it("clasifica NOT_VERIFIED como verificacion pendiente sin llamar /register", async () => {
    h.graphRequest.mockResolvedValue({
      status: "DISCONNECTED",
      code_verification_status: "NOT_VERIFIED",
    });

    await expect(
      registerPhoneNumberIfNeeded("pn_1", TOKEN, SIGNAL)
    ).resolves.toEqual({
      status: "pending",
      code: "phone_verification_pending",
    });
    expect(h.graphRequest).toHaveBeenCalledTimes(1);
  });

  it("mantiene PENDING como fallo cerrado y registra solo estados seguros", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.graphRequest.mockResolvedValue({
      status: "PENDING",
      code_verification_status: "NOT_VERIFIED",
    });

    await expect(
      registerPhoneNumberIfNeeded("pn_1", TOKEN, SIGNAL)
    ).resolves.toEqual({
      status: "failed",
      code: "phone_registration_failed",
    });
    expect(warn).toHaveBeenCalledWith("[embedded-signup-state]", {
      status: "PENDING",
      code_verification_status: "NOT_VERIFIED",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("pn_1");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });

  it("no registra valores de estado que no pasan la regex segura", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.graphRequest.mockResolvedValue({
      status: "PENDING token-super-secreto",
      code_verification_status: "not_verified",
    });

    await registerPhoneNumberIfNeeded("pn_1", TOKEN, SIGNAL);

    expect(warn).toHaveBeenCalledWith("[embedded-signup-state]", {});
    expect(JSON.stringify(warn.mock.calls)).not.toContain("token-super-secreto");
  });

  it.each([
    [133005, "registration_pin_invalid"],
    [133016, "registration_attempts_exceeded"],
  ] as const)("clasifica %s con codigo estable distinto y no reintenta", async (code, stableCode) => {
    h.graphRequest
      .mockResolvedValueOnce({
        status: "DISCONNECTED",
        code_verification_status: "VERIFIED",
      })
      .mockRejectedValueOnce(metaError(400, code));

    await expect(
      registerPhoneNumberIfNeeded("pn_1", TOKEN, SIGNAL)
    ).resolves.toEqual({ status: "failed", code: stableCode });
    expect(h.graphRequest).toHaveBeenCalledTimes(2);
  });

  it("clasifica 133006 como verificacion pendiente de forma explicita", async () => {
    h.graphRequest
      .mockResolvedValueOnce({
        status: "DISCONNECTED",
        code_verification_status: "VERIFIED",
      })
      .mockRejectedValueOnce(metaError(400, 133006, 2388001));

    await expect(registerPhoneNumberIfNeeded("pn_1", TOKEN, SIGNAL)).resolves.toEqual({
      status: "pending",
      code: "phone_verification_pending",
    });
  });

  it("trata cualquier otro 4xx como fallo con codigo estable", async () => {
    h.graphRequest
      .mockResolvedValueOnce({
        status: "DISCONNECTED",
        code_verification_status: "VERIFIED",
      })
      .mockRejectedValueOnce(metaError(400, 999999, 123));

    await expect(registerPhoneNumberIfNeeded("pn_1", TOKEN, SIGNAL)).resolves.toEqual({
      status: "failed",
      code: "phone_registration_failed",
    });
  });

  it.each([
    ["5xx", metaError(503, 2)],
    ["red", new MetaApiError(RAW_META_TEXT, { status: 0, details: new Error(RAW_META_TEXT) })],
  ])("trata %s como fallo, nunca como exito", async (_case, error) => {
    h.graphRequest
      .mockResolvedValueOnce({
        status: "DISCONNECTED",
        code_verification_status: "VERIFIED",
      })
      .mockRejectedValueOnce(error);

    await expect(registerPhoneNumberIfNeeded("pn_1", TOKEN, SIGNAL)).resolves.toEqual({
      status: "failed",
      code: "meta_unavailable",
    });
  });

  it("no filtra token, texto crudo ni identificadores sin validar en logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.graphRequest
      .mockResolvedValueOnce({
        status: "DISCONNECTED",
        code_verification_status: "VERIFIED",
      })
      .mockRejectedValueOnce(
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

    await registerPhoneNumberIfNeeded("pn_1", TOKEN, SIGNAL);

    const output = JSON.stringify(warn.mock.calls);
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(OAUTH_CODE);
    expect(output).not.toContain(RAW_META_TEXT);
    expect(output).not.toContain("trace con espacios");
  });
});

describe("intercambio de code con timeout real", () => {
  it("no oculta un TimeoutError ocurrido al leer el cuerpo", async () => {
    const signal = AbortSignal.timeout(10);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      }))
    );

    const error = await exchangeCodeForToken(OAUTH_CODE, signal).catch(
      (caught) => caught
    );

    expect(error).toMatchObject({ name: "TimeoutError" });
  });
});

describe("pertenencia phoneNumberId a WABA", () => {
  it("rechaza un numero que no aparece en la lista completa", async () => {
    h.graphRequest.mockResolvedValue({ data: [{ id: "pn_otro" }] });

    await expect(
      verifyPhoneNumberBelongsToWaba("waba_1", "pn_1", TOKEN, SIGNAL)
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
      verifyPhoneNumberBelongsToWaba("waba_1", "pn_1", TOKEN, SIGNAL)
    ).resolves.toBe(true);
    expect(h.graphRequest).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("after=cursor-seguro"),
      { token: TOKEN, signal: SIGNAL }
    );
  });

  it("impone un tope de 10 paginas y falla cerrado", async () => {
    h.graphRequest.mockImplementation(async () => {
      if (h.graphRequest.mock.calls.length > 10) {
        throw metaError(503, 2);
      }
      return {
        data: [{ id: "pn_otro" }],
        paging: {
          cursors: { after: `cursor-${h.graphRequest.mock.calls.length}` },
          next: "https://example.invalid/next",
        },
      };
    });

    await expect(
      verifyPhoneNumberBelongsToWaba("waba_1", "pn_1", TOKEN, SIGNAL)
    ).rejects.toThrow("No pudimos verificar el número con Meta");
    expect(h.graphRequest).toHaveBeenCalledTimes(10);
  });

  it("conserva TimeoutError real para que la ruta lo convierta en mensaje fijo", async () => {
    const signal = AbortSignal.timeout(10);
    h.graphRequest.mockImplementation(
      (_path: string, opts: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener(
            "abort",
            () => reject(opts.signal?.reason),
            { once: true }
          );
        })
    );

    const error = await verifyPhoneNumberBelongsToWaba(
      "waba_1",
      "pn_1",
      TOKEN,
      signal
    ).catch((caught) => caught);

    expect(error).toMatchObject({ name: "TimeoutError" });
  });

  it("rechaza si Graph falla y no filtra el error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.graphRequest.mockRejectedValue(metaError(503, 2));

    await expect(
      verifyPhoneNumberBelongsToWaba("waba_1", "pn_1", TOKEN, SIGNAL)
    ).rejects.toThrow("No pudimos verificar el número con Meta");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(RAW_META_TEXT);
  });
});
