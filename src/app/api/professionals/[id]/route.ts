import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import { BeautyCatalogError, updateProfessional } from "@/server/beauty/catalog";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  phone: z.string().max(40).nullish(),
  email: z.string().email().max(254).nullish(),
  userId: z.string().min(1).nullish(),
  timezone: z.string().trim().min(1).optional(),
  color: z.string().max(40).nullish(),
  serviceIds: z.array(z.string().min(1)).max(100).optional(),
});

export const PATCH = withOrgPermissions(
  ["settings.update"],
  async (session, req: Request, context: Params) => {
    const body = await parseBody(req, patchSchema);
    if (!body.ok) return body.response;
    const { id } = await context.params;
    try {
      return Response.json({
        professional: await updateProfessional(
          session.organizationId,
          id,
          body.data
        ),
      });
    } catch (error) {
      if (error instanceof BeautyCatalogError) {
        return apiError(error.code === "not_found" ? 404 : 422, error.code, error.message);
      }
      throw error;
    }
  }
);
