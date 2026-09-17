import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import { hasOrganizationPermission } from "@/lib/auth/permissions";
import { publish } from "@/server/events/bus";
import { serializeConversation, getConversation, updateConversation } from "@/server/inbox/queries";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  aiEnabled: z.boolean().optional(),
  reactivate: z.boolean().optional(),
  markRead: z.boolean().optional(),
});

type Params = { params: Promise<{ id: string }> };

export const PATCH = withOrgPermissions(["conversations.read"], async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  if (
    (body.data.aiEnabled !== undefined || body.data.reactivate) &&
    !hasOrganizationPermission(session.role, "ai.use", {
      isSuperadmin: session.isSuperadmin,
    })
  ) {
    return apiError(403, "forbidden", "No tienes permiso para controlar la IA de esta conversación");
  }

  const updated = await updateConversation(session.organizationId, id, body.data);
  if (!updated) return apiError(404, "not_found", "Conversación no encontrada");

  const row = await getConversation(session.organizationId, id);
  if (row) {
    const dto = serializeConversation(row.conversation, row.contact);
    publish(session.organizationId, {
      type: "conversation.updated",
      data: { conversation: dto },
    });
    return Response.json({ conversation: dto });
  }
  return Response.json({ conversation: null });
});
