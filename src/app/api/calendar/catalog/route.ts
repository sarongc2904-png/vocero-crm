import { withOrgPermissions } from "@/lib/api";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { listProfessionals, listServices } from "@/server/beauty/catalog";

export const dynamic = "force-dynamic";

/**
 * Catálogo mínimo para que un operador pueda crear una cita.
 *
 * No expone teléfono, correo ni campos administrativos de profesionales y
 * evita conceder `settings.read` a quien sólo necesita agendar.
 */
export const GET = withOrgPermissions(["appointments.create"], async (session) => {
  if (!agendaEnabled()) return agendaDisabledResponse();

  const [services, professionals] = await Promise.all([
    listServices(session.organizationId),
    listProfessionals(session.organizationId),
  ]);

  return Response.json({
    services: services
      .filter((service) => service.active)
      .map((service) => ({
        id: service.id,
        name: service.name,
        durationMinutes: service.durationMinutes,
        priceCents: service.priceCents,
        currency: service.currency,
      })),
    professionals: professionals
      .filter((professional) => professional.status === "active")
      .map((professional) => ({
        id: professional.id,
        name: professional.name,
        serviceIds: professional.serviceIds,
      })),
  });
});
