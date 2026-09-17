import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import { auditPrivilegedAction } from "@/server/auth/audit";
import {
  getConversationAssignment,
  setConversationAssignment,
} from "@/server/inbox/assignment";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const assignmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("member"), id: z.string().trim().min(1) }),
  z.object({ kind: z.literal("team"), id: z.string().trim().min(1) }),
]);

export const GET = withOrgPermissions(
  ["conversations.read"],
  async (session, _req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    const assignment = await getConversationAssignment(
      session.organizationId,
      id
    );
    return Response.json({ assignment });
  }
);

export const PATCH = withOrgPermissions(
  ["conversations.assign"],
  async (session, req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    const body = await parseBody(req, assignmentSchema);
    if (!body.ok) return body.response;

    const target =
      body.data.kind === "none"
        ? null
        : { kind: body.data.kind, id: body.data.id };

    const ok = await setConversationAssignment({
      organizationId: session.organizationId,
      conversationId: id,
      actorUserId: session.userId,
      target,
    });
    if (!ok) {
      return apiError(
        404,
        "not_found",
        "Conversación o destino de asignación no encontrado en este tenant"
      );
    }

    const assignment = await getConversationAssignment(
      session.organizationId,
      id
    );
    await auditPrivilegedAction(session, {
      action: "conversation.assign",
      targetType: "conversation",
      targetId: id,
      metadata: assignment,
    });

    return Response.json({ assignment });
  }
);
