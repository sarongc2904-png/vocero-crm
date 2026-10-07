import { withOrgPermissions } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { quotesDisabledResponse, quotesEnabled } from "@/server/quotes/flag";
import { quoteErrorResponse } from "@/server/quotes/http";
import { issueQuoteLink, revokeQuoteLinks } from "@/server/quotes/links";

export const dynamic = "force-dynamic";

/**
 * Enlace público de una cotización, desde el CRM (usuario con sesión).
 *
 * POST   → emite un enlace nuevo (revoca los anteriores) y devuelve el token
 *          UNA sola vez. Una cotización en `borrador` pasa a `enviada`.
 * DELETE → revoca los enlaces vivos; el cliente ve el mismo 404 que con un
 *          token inexistente.
 *
 * Compartir una cotización con el cliente es responderle, así que pide
 * `conversations.reply`. El bot NO tiene esta operación: solo crea borradores.
 */

const noStore = { "cache-control": "no-store" };

const guarded = (
  handler: (organizationId: string, quoteId: string) => Promise<Response>
) =>
  withOrgPermissions(
    ["conversations.reply"],
    async (session, _req: Request, ctx: { params: Promise<{ id: string }> }) => {
      const { id } = await ctx.params;
      try {
        return await handler(session.organizationId, id);
      } catch (err) {
        return quoteErrorResponse(err);
      }
    }
  );

const issue = guarded(async (organizationId, quoteId) => {
  const { token, expiresAt } = await issueQuoteLink({ organizationId, quoteId });
  const base = getEnv().APP_BASE_URL.replace(/\/+$/, "");
  return Response.json(
    { url: `${base}/p/${token}`, token, expiresAt: expiresAt.toISOString() },
    { status: 201, headers: noStore }
  );
});

const revoke = guarded(async (organizationId, quoteId) => {
  const { revoked } = await revokeQuoteLinks({ organizationId, quoteId });
  return Response.json({ revoked }, { headers: noStore });
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!quotesEnabled()) return quotesDisabledResponse();
  return issue(req, ctx);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!quotesEnabled()) return quotesDisabledResponse();
  return revoke(req, ctx);
}
