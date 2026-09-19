import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import {
  BeautyCatalogError,
  createProfessional,
  listProfessionals,
} from "@/server/beauty/catalog";

export const dynamic = "force-dynamic";

const professionalSchema = z.object({
  name: z.string().trim().min(1).max(120),
  status: z.enum(["active", "inactive"]).default("active"),
  phone: z.string().max(40).nullish(),
  email: z.string().email().max(254).nullish(),
  userId: z.string().min(1).nullish(),
  timezone: z.string().trim().min(1).default("America/Mexico_City"),
  color: z.string().max(40).nullish(),
  serviceIds: z.array(z.string().min(1)).max(100).default([]),
});

export const GET = withOrgPermissions(["settings.read"], async (session) => {
  return Response.json({
    professionals: await listProfessionals(session.organizationId),
  });
});

export const POST = withOrgPermissions(
  ["settings.update"],
  async (session, req: Request) => {
    const body = await parseBody(req, professionalSchema);
    if (!body.ok) return body.response;
    try {
      const professional = await createProfessional(
        session.organizationId,
        {
          ...body.data,
          timezone: body.data.timezone ?? "America/Mexico_City",
        }
      );
      return Response.json({ professional }, { status: 201 });
    } catch (error) {
      if (error instanceof BeautyCatalogError) {
        return apiError(error.code === "not_found" ? 404 : 422, error.code, error.message);
      }
      throw error;
    }
  }
);
