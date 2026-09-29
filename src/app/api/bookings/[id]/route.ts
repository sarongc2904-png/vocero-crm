import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { hasOrganizationPermission } from "@/lib/auth/permissions";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import {
  cancelBooking,
  markBookingStatus,
  rescheduleBooking,
  retryMeetingLink,
} from "@/server/agenda/service";
import {
  BOOKING_PATCH_PERMISSION,
  bookingErrorResponse,
} from "@/server/agenda/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reschedule"), startUtc: z.string().min(1) }),
  z.object({ action: z.literal("cancel") }),
  z.object({
    action: z.literal("status"),
    status: z.enum(["realizada", "no_show"]),
  }),
  z.object({ action: z.literal("retry_link") }),
]);

/**
 * SEC-V5 — Cada acción exige su permiso de citas.
 *
 * Antes la ruta usaba `withAuth` a secas: cualquier miembro podía reprogramar,
 * cancelar, marcar el resultado o reintentar el enlace de una cita de su
 * organización sin ningún permiso de `appointments.*`, mientras que GET/POST sí
 * lo exigían. Hoy los tres roles tienen los cuatro permisos, así que el
 * comportamiento de nadie cambia; la puerta se cierra para el primer rol
 * restringido (solo lectura / supervisor). El mapa vive en
 * `server/agenda/http.ts` para poder probarse.
 */
export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  const required = BOOKING_PATCH_PERMISSION[body.data.action];
  if (
    !hasOrganizationPermission(session.role, required, {
      isSuperadmin: session.isSuperadmin,
    })
  ) {
    return apiError(
      403,
      "forbidden",
      "No tienes permisos para realizar esta acción en la organización activa"
    );
  }

  try {
    switch (body.data.action) {
      case "reschedule": {
        const result = await rescheduleBooking({
          organizationId: session.organizationId,
          bookingId: id,
          startUtc: body.data.startUtc,
        });
        return Response.json({ ok: true, label: result.label });
      }
      case "cancel": {
        await cancelBooking({
          organizationId: session.organizationId,
          bookingId: id,
        });
        return Response.json({ ok: true });
      }
      case "status": {
        await markBookingStatus({
          organizationId: session.organizationId,
          bookingId: id,
          status: body.data.status,
        });
        return Response.json({ ok: true });
      }
      case "retry_link": {
        const result = await retryMeetingLink({
          organizationId: session.organizationId,
          bookingId: id,
        });
        return Response.json({
          ok: true,
          meetingLink: result.meetingLink,
          linkPending: result.linkPending,
        });
      }
    }
  } catch (err) {
    return bookingErrorResponse(err);
  }
});
