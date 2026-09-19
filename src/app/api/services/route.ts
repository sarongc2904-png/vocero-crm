import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import {
  BeautyCatalogError,
  createService,
  listServices,
} from "@/server/beauty/catalog";

export const dynamic = "force-dynamic";

const serviceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  category: z.string().max(120).nullish(),
  durationMinutes: z.number().int().min(5).max(1440),
  priceCents: z.number().int().min(0),
  currency: z.string().trim().length(3).default("MXN"),
  active: z.boolean().default(true),
  bufferBeforeMinutes: z.number().int().min(0).max(240).default(0),
  bufferAfterMinutes: z.number().int().min(0).max(240).default(0),
});

export const GET = withOrgPermissions(["settings.read"], async (session) => {
  return Response.json({ services: await listServices(session.organizationId) });
});

export const POST = withOrgPermissions(
  ["settings.update"],
  async (session, req: Request) => {
    const body = await parseBody(req, serviceSchema);
    if (!body.ok) return body.response;
    try {
      const service = await createService(session.organizationId, body.data);
      return Response.json({ service }, { status: 201 });
    } catch (error) {
      if (error instanceof BeautyCatalogError) {
        return apiError(422, error.code, error.message);
      }
      throw error;
    }
  }
);
