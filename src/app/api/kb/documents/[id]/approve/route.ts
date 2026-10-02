import { apiError, withOrgRoles } from "@/lib/api";
import { auditPrivilegedAction } from "@/server/auth/audit";
import {
  approveKnowledgeDocument,
  KnowledgeDocumentLifecycleError,
} from "@/server/kb/documents/lifecycle";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export const POST = withOrgRoles(
  ["owner", "admin"],
  async (session, _request: Request, context: Params) => {
    const { id } = await context.params;
    try {
      const document = await approveKnowledgeDocument(
        session.organizationId,
        id
      );
      await auditPrivilegedAction(session, {
        action: "knowledge.document.approve",
        targetType: "kb_document",
        targetId: id,
        metadata: {
          filename: document.filename,
          mimeType: document.mimeType,
          fileSize: document.fileSize,
        },
      });
      return Response.json({ document });
    } catch (error) {
      if (error instanceof KnowledgeDocumentLifecycleError) {
        return apiError(error.status, error.code, error.message);
      }
      throw error;
    }
  }
);
