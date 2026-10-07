import { quotesEnabled } from "@/server/quotes/flag";
import { getPublicLogo, getPublicQuote } from "@/server/quotes/public";
import {
  logPublicError,
  publicNotFound,
  publicRateLimited,
  PUBLIC_HEADERS,
} from "@/server/quotes/public-http";

export const dynamic = "force-dynamic";

/**
 * GET /p/:token/logo — logo del negocio servido POR EL TOKEN: la ruta de
 * branding normal pide el id de la organización, y aquí no exponemos ninguno.
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  if (!quotesEnabled()) return publicNotFound();
  const { token } = await ctx.params;
  const limited = publicRateLimited(req, token, "view");
  if (limited) return limited;

  try {
    const found = await getPublicQuote(token);
    if (!found) return publicNotFound();
    const logo = await getPublicLogo(found.organizationId, found.quote.business.name);
    return new Response(new Uint8Array(logo.bytes), {
      headers: {
        ...PUBLIC_HEADERS,
        "content-type": logo.mime,
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      },
    });
  } catch (err) {
    logPublicError("logo", err);
    return new Response(null, { status: 500, headers: PUBLIC_HEADERS });
  }
}
