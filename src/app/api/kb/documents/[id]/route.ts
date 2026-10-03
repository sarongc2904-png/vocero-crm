import { apiError, withOrgRoles } from "@/lib/api";
import { auditPrivilegedAction } from "@/server/auth/audit";
import {
  deleteKnowledgeDocument,
  getKnowledgeDocument,
  KnowledgeDocumentLifecycleError,
} from "@/server/kb/documents/lifecycle";
import { getScheduleCoherence } from "@/server/commercial/schedule-coherence";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export const GET = withOrgRoles(
  ["owner", "admin"],
  async (session, _request: Request, context: Params) => {
    const { id } = await context.params;
    const detail = await getKnowledgeDocument(session.organizationId, id);
    if (!detail) return apiError(404, "not_found", "Documento no encontrado");
    return Response.json(detail);
  }
);

export const DELETE = withOrgRoles(
  ["owner", "admin"],
  async (session, _request: Request, context: Params) => {
    const { id } = await context.params;
    try {
      const document = await deleteKnowledgeDocument(
        session.organizationId,
        id
      );
      await auditPrivilegedAction(session, {
        action: "knowledge.document.delete",
        targetType: "kb_document",
        targetId: id,
        metadata: {
          filename: document.filename,
          mimeType: document.mimeType,
          fileSize: document.fileSize,
        },
      });
      return Response.json({
        deleted: true,
        scheduleCoherence: await getScheduleCoherence(session.organizationId),
      });
    } catch (error) {
      if (error instanceof KnowledgeDocumentLifecycleError) {
        return apiError(error.status, error.code, error.message);
      }
      throw error;
    }
  }
);
