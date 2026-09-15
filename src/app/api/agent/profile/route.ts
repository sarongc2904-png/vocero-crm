import { z } from "zod";
import { apiError, parseBody, withOrgRoles } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { isAiConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

export const GET = withOrgRoles(["owner", "admin"], async (session) => {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.agentProfile)
    .where(scoped(schema.agentProfile.organizationId, session.organizationId))
    .limit(1);
  const p = rows[0];
  if (!p) return apiError(404, "not_found", "Perfil del agente no encontrado");
  return Response.json({
    profile: {
      enabled: p.enabled,
      name: p.name,
      tone: p.tone,
      instructions: p.instructions,
      escalationRules: p.escalationRules,
      greeting: p.greeting,
    },
    aiConfigured: isAiConfigured(),
  });
});

const putSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string().trim().min(1).max(60).optional(),
  tone: z.string().max(500).nullable().optional(),
  instructions: z.string().max(8000).nullable().optional(),
  escalationRules: z.string().max(4000).nullable().optional(),
  greeting: z.string().max(1000).nullable().optional(),
});

export const PUT = withOrgRoles(["owner", "admin"], async (session, req: Request) => {
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const updated = await db
    .update(schema.agentProfile)
    .set({ ...body.data, updatedAt: new Date() })
    .where(scoped(schema.agentProfile.organizationId, session.organizationId))
    .returning();
  if (!updated[0]) return apiError(404, "not_found", "Perfil no encontrado");
  return Response.json({ ok: true });
});
