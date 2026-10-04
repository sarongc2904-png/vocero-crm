import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  graphRequest,
  MetaApiError,
  normalizeMx,
  normalizeRecipient,
} from "@/lib/meta/client";

beforeAll(() => {
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.DATABASE_URL = "postgresql://t:t@localhost:5432/t";
  process.env.BETTER_AUTH_SECRET = "secret-de-prueba-meta-client";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-test";
  process.env.META_GRAPH_BASE_URL = "https://graph.facebook.com";
  process.env.META_GRAPH_API_VERSION = "v25.0";
});

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("graphRequest AbortSignal", () => {
  it("sin signal conserva exactamente los argumentos de fetch de 6b6efa0", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: "pn_1" }));
    vi.stubGlobal("fetch", fetchMock);

    await graphRequest("pn_1?fields=id", { token: "token-prueba" });

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://graph.facebook.com/v25.0/pn_1?fields=id",
      {
        method: "GET",
        headers: { Authorization: "Bearer token-prueba" },
        body: undefined,
      }
    );
  });

  it("con signal ya abortado cancela y conserva AbortError distinguible", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        init?.signal?.throwIfAborted();
        return Response.json({ ok: true });
      })
    );

    const error = await graphRequest("pn_1", {
      token: "token-prueba",
      signal: controller.signal,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(error).not.toBeInstanceOf(MetaApiError);
  });

  it("aborta una petición durante la espera y conserva AbortError", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) => {
          if (!init?.signal) return Promise.reject(new Error("signal ausente"));
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("texto crudo", "AbortError"))
            );
          });
        }
      )
    );

    const pending = graphRequest("pn_1", {
      token: "token-prueba",
      signal: controller.signal,
    });
    controller.abort();
    const error = await pending.catch((caught) => caught);

    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(error).not.toBeInstanceOf(MetaApiError);
  });
});

describe("normalizeRecipient", () => {
  it("México móvil legado: 521 + 10 dígitos → 52 + 10 dígitos", () => {
    expect(normalizeRecipient("5215512345678")).toBe("525512345678");
  });

  it("México ya normalizado queda intacto", () => {
    expect(normalizeRecipient("525512345678")).toBe("525512345678");
  });

  it("Argentina móvil: 549 + 10 dígitos → 54 + 10 dígitos (issue #35)", () => {
    // Meta reporta `549…` pero la lista de destinatarios de prueba solo
    // acepta el número sin el 9: con el 9 responde 131030 y el panel muestra
    // el número como habilitado, así que el error manda a revisar donde no es.
    expect(normalizeRecipient("5491122334455")).toBe("541122334455");
  });

  it("Argentina ya normalizada queda intacta", () => {
    expect(normalizeRecipient("541122334455")).toBe("541122334455");
  });

  it("otros países quedan intactos", () => {
    expect(normalizeRecipient("14155552671")).toBe("14155552671");
    expect(normalizeRecipient("50761234567")).toBe("50761234567");
  });

  it("no confunde números que empiezan en el troncal pero con otra longitud", () => {
    expect(normalizeRecipient("521123")).toBe("521123");
    expect(normalizeRecipient("549123")).toBe("549123");
    // 549 + 11 dígitos no es un móvil argentino: no se toca.
    expect(normalizeRecipient("54911223344556")).toBe("54911223344556");
  });

  it("la identidad NO se toca: normalizar al enviar es asimétrico a propósito", () => {
    // Si la ingesta reescribiera `549…`, la identidad guardada dejaría de
    // coincidir con el `wa_id` de cada webhook y el contacto se partiría.
    expect(normalizeMx("5491122334455")).toBe("5491122334455");
  });
});

describe("MetaApiError.isAuthError", () => {
  it("status 401 es error de auth", () => {
    expect(new MetaApiError("x", { status: 401 }).isAuthError).toBe(true);
  });

  it("code 190 es error de auth (token vencido)", () => {
    expect(new MetaApiError("x", { status: 400, code: 190 }).isAuthError).toBe(
      true
    );
  });

  it("OAuthException solo NO basta (Meta la usa en errores transitorios)", () => {
    // Incidente 2026-08-03: un 500 con type OAuthException (código 2,
    // "service temporarily unavailable") marcaba el token como vencido y
    // bloqueaba TODO envío. El type por sí solo jamás decide.
    expect(
      new MetaApiError("x", { status: 400, type: "OAuthException" }).isAuthError
    ).toBe(false);
    expect(
      new MetaApiError("x", { status: 500, code: 2, type: "OAuthException" })
        .isAuthError
    ).toBe(false);
  });

  it("OAuthException con código 190 sí es error de auth", () => {
    expect(
      new MetaApiError("x", { status: 400, code: 190, type: "OAuthException" })
        .isAuthError
    ).toBe(true);
  });

  it("un 5xx JAMÁS es error de auth, ni con código 190", () => {
    expect(new MetaApiError("x", { status: 500 }).isAuthError).toBe(false);
    expect(
      new MetaApiError("x", { status: 500, code: 190 }).isAuthError
    ).toBe(false);
  });
});
