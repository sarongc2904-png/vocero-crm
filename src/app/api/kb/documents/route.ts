import { apiError, withOrgRoles } from "@/lib/api";
import { auditPrivilegedAction } from "@/server/auth/audit";
import { createAndProcessKnowledgeDocument } from "@/server/kb/documents/upload";
import {
  KnowledgeUploadError,
  validateKnowledgeUpload,
} from "@/server/kb/documents/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withOrgRoles(
  ["owner", "admin"],
  async (session, request: Request) => {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return apiError(422, "invalid_form", "La solicitud debe incluir multipart/form-data");
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      return apiError(422, "file_required", "Selecciona un archivo TXT o PDF");
    }

    try {
      const upload = await validateKnowledgeUpload(file);
      const document = await createAndProcessKnowledgeDocument(
        session.organizationId,
        upload
      );
      await auditPrivilegedAction(session, {
        action: "knowledge.document.upload",
        targetType: "kb_document",
        targetId: document.id,
        metadata: {
          filename: document.filename,
          mimeType: document.mimeType,
          fileSize: document.fileSize,
          status: document.status,
        },
      });
      return Response.json({ document }, { status: 201 });
    } catch (error) {
      if (error instanceof KnowledgeUploadError) {
        return apiError(error.status, error.code, error.message);
      }
      throw error;
    }
  }
);
