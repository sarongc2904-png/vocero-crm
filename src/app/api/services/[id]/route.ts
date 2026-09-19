import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import { BeautyCatalogError, updateService } from "@/server/beauty/catalog";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  category: z.string().max(120).nullish(),
  durationMinutes: z.number().int().min(5).max(1440).optional(),
  priceCents: z.number().int().min(0).optional(),
  currency: z.string().trim().length(3).optional(),
  active: z.boolean().optional(),
  bufferBeforeMinutes: z.number().int().min(0).max(240).optional(),
  bufferAfterMinutes: z.number().int().min(0).max(240).optional(),
});

export const PATCH = withOrgPermissions(
  ["settings.update"],
  async (session, req: Request, context: Params) => {
    const body = await parseBody(req, patchSchema);
    if (!body.ok) return body.response;
    const { id } = await context.params;
    try {
      return Response.json({
        service: await updateService(session.organizationId, id, body.data),
      });
    } catch (error) {
      if (error instanceof BeautyCatalogError) {
        return apiError(error.code === "not_found" ? 404 : 422, error.code, error.message);
      }
      throw error;
    }
  }
);
