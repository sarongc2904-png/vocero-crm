import { checkRateLimit } from "@/lib/rate-limit";
import { hashQuoteToken } from "@/server/quotes/links";

/**
 * Contrato HTTP de la superficie pública /p/[token] y /api/p/[token]/*.
 *
 * - Toda respuesta lleva `noindex`, `no-store` y `no-referrer`: la URL con el
 *   token no debe quedar en buscadores, cachés intermedios ni en el Referer de
 *   otro sitio.
 * - Todo "no existe" es ESTE 404, byte por byte: token mal formado, ajeno,
 *   vencido, revocado o bandera apagada son indistinguibles.
 * - Nada aquí registra el token: los errores se loguean sin URL ni params.
 */

export const PUBLIC_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "cache-control": "no-store, max-age=0",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "x-content-type-options": "nosniff",
});

export function publicNotFound(): Response {
  return new Response(null, { status: 404, headers: PUBLIC_HEADERS });
}

export function publicJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: PUBLIC_HEADERS });
}

function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * Límite por IP y por enlace. La llave del enlace es el HASH del token, para
 * que ni siquiera la memoria del rate-limiter guarde tokens en claro.
 */
export function publicRateLimited(
  req: Request,
  token: string,
  scope: "view" | "respond"
): Response | null {
  const limits =
    scope === "respond"
      ? { ip: { windowMs: 60_000, max: 10 }, token: { windowMs: 60_000, max: 5 } }
      : { ip: { windowMs: 60_000, max: 120 }, token: { windowMs: 60_000, max: 60 } };
  const byIp = checkRateLimit(`quote-public:${scope}:ip:${clientIp(req)}`, limits.ip);
  const byToken = checkRateLimit(`quote-public:${scope}:tk:${hashQuoteToken(token)}`, limits.token);
  if (byIp.allowed && byToken.allowed) return null;
  return new Response(
    JSON.stringify({ error: { code: "rate_limited", message: "Demasiadas solicitudes; intenta en un minuto" } }),
    { status: 429, headers: { ...PUBLIC_HEADERS, "content-type": "application/json", "retry-after": "60" } }
  );
}

/** Log de error de la superficie pública: jamás incluye la URL ni el token. */
export function logPublicError(where: string, err: unknown): void {
  const name = err instanceof Error ? err.name : typeof err;
  console.error(`[cotizaciones] error en ${where}: ${name}`);
}
