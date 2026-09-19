import { apiError, withAuth } from "@/lib/api";
import { dayIsoInTz, timeInTz, dayLabelInTz } from "@/lib/time/slots";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { computeAvailability } from "@/server/agenda/availability";
import { getSettings } from "@/server/agenda/settings";
import {
  computeProfessionalAvailability,
  getSchedulingContext,
} from "@/server/agenda/professional-availability";

export const dynamic = "force-dynamic";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 015 — Los huecos libres, para el operador.
 *
 * A diferencia de la superficie del bot, esta NO registra oferta: es la vista
 * de quien ya está mirando la agenda y elige de lo que ve.
 *
 * Sin huecos responde `{"slots":[]}` con 200: agenda llena es una respuesta,
 * no un error.
 */
export const GET = withAuth(async (session, req: Request) => {
  if (!agendaEnabled()) return agendaDisabledResponse();

  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const serviceId = url.searchParams.get("serviceId");
  const professionalId = url.searchParams.get("professionalId");
  if (Boolean(serviceId) !== Boolean(professionalId)) {
    return apiError(
      422,
      "invalid_body",
      "serviceId y professionalId deben enviarse juntos"
    );
  }

  const settings = await getSettings(session.organizationId);
  const now = new Date();
  const range = {
    fromISO: from && ISO_DATE.test(from) ? from : undefined,
    toISO: to && ISO_DATE.test(to) ? to : undefined,
    now,
  };
  const slots =
    serviceId && professionalId
      ? await computeProfessionalAvailability(session.organizationId, {
          ...range,
          serviceId,
          professionalId,
        })
      : await computeAvailability(session.organizationId, {
          ...range,
          settings,
        });
  const timezone =
    serviceId && professionalId
      ? (
          await getSchedulingContext({
            organizationId: session.organizationId,
            serviceId,
            professionalId,
          })
        ).professional.timezone
      : settings.timezone;

  return Response.json({
    slots: slots.map((s) => ({
      ...s,
      dayIso: dayIsoInTz(new Date(s.startUtc), timezone),
      dayLabel: dayLabelInTz(s.startUtc, timezone, now),
      time: timeInTz(s.startUtc, timezone),
    })),
  });
});
