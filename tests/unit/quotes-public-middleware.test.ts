import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, resetRateLimit } from "@/lib/rate-limit";
import { config, middleware } from "@/middleware";
import { PUBLIC_HEADERS, publicRateLimited } from "@/server/quotes/public-http";
import { hashQuoteToken } from "@/server/quotes/token-hash";

const publicQuote = vi.hoisted(() => ({
  getPublicQuote: vi.fn(),
}));

vi.mock("@/server/quotes/public", () => ({
  getPublicQuote: publicQuote.getPublicQuote,
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Response(null, {
      status: 404,
      headers: {
        "cache-control": "no-store, max-age=0",
        "referrer-policy": "no-referrer",
        "x-robots-tag": "noindex, nofollow, noarchive",
        "x-content-type-options": "nosniff",
      },
    });
  },
}));

import PublicQuotePage from "@/app/p/[token]/page";

const TOKEN = "A".repeat(43);

function request(path: string, ip = "198.51.100.10", method = "GET"): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: { "x-forwarded-for": ip },
  });
}

function matches(path: string): boolean {
  return unstable_doesMiddlewareMatch({
    config,
    nextConfig: {},
    url: `http://localhost:3000${path}`,
  });
}

async function pageResponse(token: string): Promise<Response> {
  try {
    await PublicQuotePage({ params: Promise.resolve({ token }) });
  } catch (response) {
    if (response instanceof Response) return response;
    throw response;
  }
  throw new Error("La página no produjo notFound()");
}

async function fingerprint(response: Response): Promise<string> {
  return JSON.stringify({
    status: response.status,
    headers: [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b)),
    body: await response.text(),
  });
}

beforeEach(() => {
  resetRateLimit();
  publicQuote.getPublicQuote.mockReset();
  vi.stubEnv("COTIZACIONES", "on");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Middleware de la cotización pública", () => {
  it("elimina del almacén las entradas que ya vencieron", () => {
    const globalRateLimit = globalThis as unknown as {
      __voceroRateLimit?: Map<string, number[]>;
    };
    const limit = { windowMs: 60_000, max: 1 };

    checkRateLimit("expired-entry", limit, 1_000_000);
    expect(globalRateLimit.__voceroRateLimit?.has("expired-entry")).toBe(true);

    checkRateLimit("current-entry", limit, 1_060_001);
    expect(globalRateLimit.__voceroRateLimit?.has("expired-entry")).toBe(false);
    expect(globalRateLimit.__voceroRateLimit?.has("current-entry")).toBe(true);
  });

  it("configura Node.js y deja continuar una solicitud permitida", () => {
    expect(config.runtime).toBe("nodejs");
    expect(matches(`/p/${TOKEN}`)).toBe(true);

    const response = middleware(request(`/p/${TOKEN}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("responde 429 al exceder el límite por enlace", async () => {
    for (let i = 0; i < 60; i += 1) {
      expect(middleware(request(`/p/${TOKEN}`)).status).toBe(200);
    }

    const response = middleware(request(`/p/${TOKEN}`));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual({
      error: {
        code: "rate_limited",
        message: "Demasiadas solicitudes; intenta en un minuto",
      },
    });
  });

  it("conserva las cabeceras de seguridad al continuar y al limitar", () => {
    const allowed = middleware(request(`/p/${TOKEN}`));
    for (const [name, value] of Object.entries(PUBLIC_HEADERS)) {
      expect(allowed.headers.get(name), name).toBe(value);
    }

    for (let i = 1; i < 60; i += 1) middleware(request(`/p/${TOKEN}`));
    const limited = middleware(request(`/p/${TOKEN}`));
    for (const [name, value] of Object.entries(PUBLIC_HEADERS)) {
      expect(limited.headers.get(name), name).toBe(value);
    }
  });

  it("con la bandera apagada no consulta ni contabiliza y deja el 404 a la página", async () => {
    vi.stubEnv("COTIZACIONES", "off");

    const passThrough = middleware(request(`/p/${TOKEN}`));
    expect(passThrough.status).toBe(200);
    expect(passThrough.headers.get("x-middleware-next")).toBe("1");
    expect(publicQuote.getPublicQuote).not.toHaveBeenCalled();

    const response = await pageResponse(TOKEN);
    expect(response.status).toBe(404);
    expect(publicQuote.getPublicQuote).not.toHaveBeenCalled();

    vi.stubEnv("COTIZACIONES", "on");
    for (let i = 0; i < 60; i += 1) {
      expect(middleware(request(`/p/${TOKEN}`)).status).toBe(200);
    }
    expect(middleware(request(`/p/${TOKEN}`)).status).toBe(429);
  });

  it("produce respuestas HTTP 404 equivalentes para bandera, inexistente, revocado y vencido", async () => {
    vi.stubEnv("COTIZACIONES", "off");
    const disabled = await fingerprint(await pageResponse(TOKEN));
    expect(publicQuote.getPublicQuote).not.toHaveBeenCalled();

    vi.stubEnv("COTIZACIONES", "on");
    publicQuote.getPublicQuote.mockResolvedValue(null);
    const unavailable = await Promise.all(
      ["inexistente", "revocado", "vencido"].map(async (kind, index) => ({
        kind,
        response: await fingerprint(await pageResponse(`${String(index).padStart(43, "B")}`)),
      }))
    );

    expect(JSON.parse(disabled)).toMatchObject({ status: 404, body: "" });
    for (const { kind, response } of unavailable) {
      expect(response, kind).toBe(disabled);
    }
    expect(publicQuote.getPublicQuote).toHaveBeenCalledTimes(3);
  });

  it("no aplica una segunda limitación al PDF ni al logotipo", () => {
    expect(matches(`/p/${TOKEN}/pdf`)).toBe(false);
    expect(matches(`/p/${TOKEN}/logo`)).toBe(false);
  });

  it("no cambia la ruta de respuesta del cliente", () => {
    expect(matches(`/api/p/${TOKEN}/respond`)).toBe(false);
  });

  it("conserva el límite propio de la ruta de respuesta", () => {
    const req = request(`/api/p/${TOKEN}/respond`, "192.0.2.40", "POST");
    for (let i = 0; i < 5; i += 1) {
      expect(publicRateLimited(req, TOKEN, "respond")).toBeNull();
    }
    expect(publicRateLimited(req, TOKEN, "respond")?.status).toBe(429);
  });

  it("HEAD consume cuota por enlace", () => {
    const path = `/p/${TOKEN}`;

    for (let i = 0; i < 60; i += 1) {
      expect(middleware(request(path, "198.51.100.55", "HEAD")).status).toBe(200);
    }

    const limited = middleware(request(path, "198.51.100.55", "HEAD"));

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  it("GET y HEAD comparten el mismo contador por enlace", () => {
    const path = `/p/${TOKEN}`;
    const ip = "198.51.100.56";

    for (let i = 0; i < 30; i += 1) {
      expect(middleware(request(path, ip, "GET")).status).toBe(200);
      expect(middleware(request(path, ip, "HEAD")).status).toBe(200);
    }

    expect(middleware(request(path, ip, "GET")).status).toBe(429);
    expect(middleware(request(path, ip, "HEAD")).status).toBe(429);
  });
  it("no registra el token", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    for (let i = 0; i <= 60; i += 1) middleware(request(`/p/${TOKEN}`));

    const output = [...error.mock.calls, ...warn.mock.calls, ...log.mock.calls].flat().join(" ");
    expect(output).not.toContain(TOKEN);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("contabiliza independientemente 60 por enlace y 120 por IP", () => {
    for (let i = 0; i < 120; i += 1) {
      const token = i.toString(36).padStart(43, "A");
      expect(middleware(request(`/p/${token}`, "203.0.113.7")).status, `intento ${i + 1}`).toBe(200);
    }

    const nextToken = "z".repeat(43);
    expect(middleware(request(`/p/${nextToken}`, "203.0.113.7")).status).toBe(429);
    const globalRateLimit = globalThis as unknown as {
      __voceroRateLimit?: Map<string, number[]>;
    };
    expect(
      globalRateLimit.__voceroRateLimit?.has(`quote-public:view:tk:${hashQuoteToken(nextToken)}`)
    ).toBe(false);

    expect(middleware(request(`/p/${TOKEN}`, "203.0.113.8")).status).toBe(200);
  });
});
