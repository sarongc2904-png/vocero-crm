import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import { BeautyCatalogError } from "@/server/beauty/catalog";
import {
  getProfessionalAvailability,
  replaceProfessionalAvailability,
} from "@/server/beauty/availability";

type Params = { params: Promise<{ id: string }> };

const weeklyInterval = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
});

const availabilitySchema = z.object({
  weekly: z.array(weeklyInterval).max(100),
  breaks: z.array(weeklyInterval).max(100).default([]),
  timeOff: z
    .array(
      z.object({
        startsAt: z.string().datetime(),
        endsAt: z.string().datetime(),
        reason: z.string().max(500).nullish(),
      })
    )
    .max(200)
    .default([]),
});

export const GET = withOrgPermissions(
  ["settings.read"],
  async (session, _request: Request, context: Params) => {
    const { id } = await context.params;
    try {
      return Response.json({
        availability: await getProfessionalAvailability(
          session.organizationId,
          id
        ),
      });
    } catch (error) {
      if (error instanceof BeautyCatalogError) {
        return apiError(404, error.code, error.message);
      }
      throw error;
    }
  }
);

export const PUT = withOrgPermissions(
  ["settings.update"],
  async (session, request: Request, context: Params) => {
    const body = await parseBody(request, availabilitySchema);
    if (!body.ok) return body.response;
    const { id } = await context.params;
    try {
      return Response.json({
        availability: await replaceProfessionalAvailability({
          organizationId: session.organizationId,
          professionalId: id,
          weekly: body.data.weekly,
          breaks: body.data.breaks ?? [],
          timeOff: body.data.timeOff ?? [],
        }),
      });
    } catch (error) {
      if (error instanceof BeautyCatalogError) {
        return apiError(error.code === "not_found" ? 404 : 422, error.code, error.message);
      }
      throw error;
    }
  }
);
