import { z } from "zod";
import { parseBody, withOrgPermissions } from "@/lib/api";
import { getSessionOrNull } from "@/lib/auth/session";
import { isValidHex, resolveAccentSet } from "@/lib/branding";
import { CURRENCIES } from "@/lib/money";
import { getBranding, saveBranding } from "@/server/branding";

export const dynamic = "force-dynamic";

/** GET público: el login necesita la marca antes de autenticarse. */
export async function GET() {
  const session = await getSessionOrNull();
  const branding = await getBranding(session?.organizationId);
  return Response.json({ branding, accentSet: resolveAccentSet(branding.accent) });
}

const putSchema = z.object({
  name: z.string().trim().min(1).max(30),
  accent: z.string().refine(isValidHex, "Color hex inválido (#rrggbb)"),
  /** La moneda del negocio: la única que el tablero suma. */
  currency: z.enum(CURRENCIES),
});

export const PUT = withOrgPermissions(["branding.manage"], async (session, req: Request) => {
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;
  const actual = await getBranding(session.organizationId);
  await saveBranding(session.organizationId, {
    ...body.data,
    favicon: actual.favicon,
  });
  return Response.json({ ok: true });
});
