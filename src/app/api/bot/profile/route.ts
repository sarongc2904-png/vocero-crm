import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { apiError } from "@/lib/api";
import { authenticateBotRequest } from "@/server/bot/auth";
import { serializeBotProfile } from "@/server/bot/profile";

export const dynamic = "force-dynamic";

/**
 * Perfil del agente + knowledge base para un cerebro externo.
 * GET /api/bot/profile → {profile, kb, resources}. Sin caché: cada consulta
 * refleja lo que el dueño dejó en la UI al momento (el TTL vive del lado del
 * bot, que es quien sabe cada cuánto le conviene releer).
 */
export async function GET(req: Request) {
  const auth = await authenticateBotRequest(req);
  if (!auth.ok) return auth.response;
  const organizationId = auth.organizationId;

  const db = getDb();
  const profiles = await db
    .select()
    .from(schema.agentProfile)
    .where(eq(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  const profile = profiles[0];
  if (!profile) {
    // Condición esperada (instancia sin perfil): el bot cae a su brief local.
    return apiError(404, "no_profile", "La instancia no tiene perfil de agente");
  }

  const kb = await db
    .select()
    .from(schema.kbEntry)
    .where(eq(schema.kbEntry.organizationId, organizationId))
    .orderBy(asc(schema.kbEntry.createdAt));

  return Response.json(serializeBotProfile(profile, kb));
}
