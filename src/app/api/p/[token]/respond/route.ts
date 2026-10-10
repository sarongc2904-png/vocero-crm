import { z } from "zod";
import { quotesEnabled } from "@/server/quotes/flag";
import { MAX_RESPONSE_NOTE, respondToQuote } from "@/server/quotes/public";
import {
  logPublicError,
  publicJson,
  publicNotFound,
  publicRateLimited,
  PUBLIC_HEADERS,
} from "@/server/quotes/public-http";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    decision: z.enum(["aceptar", "rechazar"]),
    comment: z.string().max(MAX_RESPONSE_NOTE).nullish(),
  })
  .strict();

/**
 * POST /api/p/:token/respond — el cliente acepta o rechaza, sin cuenta.
 *
 * 200 → quedó registrada su respuesta.
 * 409 → la cotización ya no está esperando respuesta (otra persona respondió
 *       primero, o expiró); trae el estado actual.
 * 404 → idéntico para todo token que no sirve.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  // Bandera primero: apagada no se lee el body, no se cuenta nada, no se escribe nada.
  if (!quotesEnabled()) return publicNotFound();
  const { token } = await ctx.params;

  const limited = publicRateLimited(req, token, "respond");
  if (limited) return limited;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = null;
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return publicJson({ error: { code: "invalid_body", message: "Respuesta inválida" } }, 422);
  }

  try {
    const result = await respondToQuote({
      token,
      decision: parsed.data.decision,
      comment: parsed.data.comment ?? null,
    });
    switch (result.outcome) {
      case "not_found":
        return publicNotFound();
      case "recorded":
        return publicJson({ status: result.status });
      case "not_open":
        return publicJson(
          { error: { code: "not_open", message: "Esta cotización aún no está lista para responder" } },
          409
        );
      case "already":
        return publicJson(
          { error: { code: "already_responded", message: "Esta cotización ya no espera respuesta" }, status: result.status },
          409
        );
    }
  } catch (err) {
    logPublicError("respond", err);
    return new Response(null, { status: 500, headers: PUBLIC_HEADERS });
  }
}
