import { NextResponse, type NextRequest } from "next/server";
import { quotesEnabled } from "@/server/quotes/flag";
import { PUBLIC_HEADERS, publicRateLimited } from "@/server/quotes/public-http";

export const config = {
  matcher: "/p/:token",
  // publicRateLimited() usa SHA-256 de node:crypto.
  runtime: "nodejs",
};

function withPublicHeaders(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(PUBLIC_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

/** Protege solo la vista HTML pública /p/[token] en GET y HEAD. */
export function middleware(req: NextRequest): Response {
  if (req.method !== "GET" && req.method !== "HEAD") return NextResponse.next();

  const match = /^\/p\/([^/]+)$/.exec(req.nextUrl.pathname);
  const token = match?.[1];
  if (!token) return NextResponse.next();

  // La página conserva la única respuesta 404. Aquí solo evitamos contar.
  if (!quotesEnabled()) {
    return withPublicHeaders(NextResponse.next());
  }

  const limited = publicRateLimited(req, token, "view");
  if (limited) return limited;

  return withPublicHeaders(NextResponse.next());
}
