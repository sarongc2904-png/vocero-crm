import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { apiError, parseBody } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { resolveStage } from "@/server/ai/actions";
import { moveLeadToStage } from "@/server/leads/stage-history";
import { LOSS_REASON_LABEL, type LossReason } from "@/lib/types";

export const dynamic = "force-dynamic";

const LOSS_REASONS = Object.keys(LOSS_REASON_LABEL) as [LossReason, ...LossReason[]];

const bodySchema = z.object({
  leadId: z.string().min(1),
  stageName: z.string().min(1),
  lossReason: z.enum(LOSS_REASONS).optional(),
  lossNote: z.string().max(500).optional(),
});

/**
 * Califica un lead moviéndolo de etapa — la contraparte de `/api/bot/ficha`
 * para cuando la calificación es "avanzó" y no solo "esto es lo que sabemos
 * de él". Mismo camino (`moveLeadToStage`) y misma bitácora que usa el dueño
 * arrastrando la tarjeta o el agente en vivo: `source: "bot"` dice quién fue.
 *
 * `stageName` es el nombre de una etapa de esta organización (exacto o
 * case-insensitive vía `resolveStage`) — el cerebro externo no inventa IDs.
 */
export async function PUT(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const db = getDb();
  const stages = await db
    .select({ id: schema.pipelineStage.id, name: schema.pipelineStage.name })
    .from(schema.pipelineStage)
    .where(eq(schema.pipelineStage.organizationId, organizationId));

  const target = resolveStage(body.data.stageName, stages);
  if (!target) {
    return apiError(
      422,
      "stage_not_found",
      `No existe una etapa llamada "${body.data.stageName}" en esta organización`
    );
  }

  const result = await moveLeadToStage({
    organizationId,
    leadId: body.data.leadId,
    toStageId: target.id,
    source: "bot",
    lossReason: body.data.lossReason ?? null,
    lossNote: body.data.lossNote ?? null,
  });

  if (!result.ok) {
    if (result.reason === "lead_not_found") {
      return apiError(404, "not_found", "Lead no encontrado");
    }
    if (result.reason === "loss_reason_required") {
      return apiError(
        422,
        "loss_reason_required",
        "Esa etapa es de pérdida: incluye lossReason"
      );
    }
    return apiError(422, "stage_not_found", "Etapa no encontrada");
  }

  return Response.json({
    ok: true,
    leadId: result.lead.id,
    stage: { id: target.id, name: target.name },
    changed: result.changed,
  });
}
