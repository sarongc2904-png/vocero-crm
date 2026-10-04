import { beforeEach, describe, expect, it, vi } from "vitest";
import { testConnection } from "@/server/whatsapp/connect";

beforeEach(() => {
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.DATABASE_URL = "postgresql://t:t@localhost:5432/t";
  process.env.BETTER_AUTH_SECRET = "secret-de-prueba-whatsapp-connect";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-test";
  process.env.META_GRAPH_BASE_URL = "https://graph.facebook.com";
  process.env.META_GRAPH_API_VERSION = "v25.0";
  vi.unstubAllGlobals();
});

describe("testConnection seguro", () => {
  it("no devuelve texto crudo de Meta para un 4xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              message: "texto crudo privado de Meta token-super-secreto",
              code: 100,
            },
          },
          { status: 400 }
        )
      )
    );

    await expect(testConnection("pn_1", "token-super-secreto")).resolves.toEqual({
      ok: false,
      code: "meta_error",
      message: "Meta rechazó la verificación del número. Revisa la configuración e intenta nuevamente.",
    });
  });

  it("convierte AbortError en timeout estable y sin texto crudo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        init?.signal?.throwIfAborted();
        return Response.json({ display_phone_number: "+52" });
      })
    );

    await expect(
      testConnection("pn_1", "token-super-secreto", AbortSignal.abort())
    ).resolves.toEqual({
      ok: false,
      code: "meta_timeout",
      message: "Meta tardó demasiado en responder. Intenta nuevamente.",
    });
  });
});
