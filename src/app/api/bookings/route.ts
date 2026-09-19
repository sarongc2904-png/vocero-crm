import { z } from "zod";
import { parseBody, withAuth } from "@/lib/api";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { listBookings } from "@/server/agenda/queries";
import { createBlock, createSessionBooking } from "@/server/agenda/service";
import { bookingErrorResponse, bookingPayload } from "@/server/agenda/http";

export const dynamic = "force-dynamic";

export const GET = withAuth(async (session) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const bookings = await listBookings(session.organizationId);
  return Response.json({ bookings });
});

const postSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("session"),
    contactId: z.string().min(1),
    conversationId: z.string().min(1).nullish(),
    serviceId: z.string().min(1).optional(),
    professionalId: z.string().min(1).optional(),
    startUtc: z.string().min(1),
    notes: z.string().nullish(),
  }),
  z.object({
    kind: z.literal("block"),
    professionalId: z.string().min(1).optional(),
    startUtc: z.string().min(1),
    durationMinutes: z.number().int().min(5).max(600),
    notes: z.string().nullish(),
  }),
]);

/**
 * 015 — El operador agenda o bloquea.
 *
 * Responde **201**, igual que la superficie del bot: el código de creación es
 * contrato, no un detalle.
 *
 * A diferencia del agente, el operador NO pasa por `offered_slot`: elige de la
 * disponibilidad que está viendo en pantalla. La re-validación y el candado
 * anti doble-booking sí aplican igual.
 */
export const POST = withAuth(async (session, req: Request) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const body = await parseBody(req, postSchema);
  if (!body.ok) return body.response;

  try {
    if (body.data.kind === "block") {
      const block = await createBlock({
        organizationId: session.organizationId,
        startUtc: body.data.startUtc,
        durationMinutes: body.data.durationMinutes,
        professionalId: body.data.professionalId ?? null,
        notes: body.data.notes ?? null,
      });
      return Response.json({ booking: { id: block.id } }, { status: 201 });
    }

    const result = await createSessionBooking({
      organizationId: session.organizationId,
      contactId: body.data.contactId,
      conversationId: body.data.conversationId ?? null,
      serviceId: body.data.serviceId,
      professionalId: body.data.professionalId,
      startUtc: body.data.startUtc,
      notes: body.data.notes ?? null,
      source: "manual",
      requireOffer: false,
    });
    return Response.json(
      { booking: { id: result.booking.id }, ...bookingPayload(result) },
      { status: 201 }
    );
  } catch (err) {
    return bookingErrorResponse(err);
  }
});
