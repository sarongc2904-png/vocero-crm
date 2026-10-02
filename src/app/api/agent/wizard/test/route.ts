import { z } from "zod";
import { apiError, parseBody, withOrgRoles } from "@/lib/api";
import { isAiConfigured } from "@/lib/env";
import { runWizardAgentTest } from "@/server/lab/wizard-test";

export const dynamic = "force-dynamic";

const testSchema = z.object({
  message: z.string().trim().min(1).max(2_000),
});

export const POST = withOrgRoles(["owner", "admin"], async (session, req: Request) => {
  if (!isAiConfigured()) {
    return apiError(409, "ai_not_configured", "La IA todavía no está conectada");
  }
  const body = await parseBody(req, testSchema);
  if (!body.ok) return body.response;

  const result = await runWizardAgentTest(
    session.organizationId,
    body.data.message
  );
  return Response.json(result);
});
