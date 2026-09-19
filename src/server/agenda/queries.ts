import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { partsInTz } from "@/lib/time/slots";
import { getSettings } from "@/server/agenda/settings";

/** 015 — Listado de citas para la UI, con la hora en la zona del negocio. */

export type BookingListItem = {
  id: string;
  kind: "session" | "block";
  status: "agendada" | "realizada" | "no_show" | "cancelada";
  source: "manual" | "ai";
  scheduledAtUtc: string;
  durationMinutes: number;
  date: string;
  time: string;
  weekday: string;
  contact: { id: string; name: string } | null;
  service: { id: string; name: string } | null;
  professional: { id: string; name: string } | null;
  conversationId: string | null;
  /** Con qué conector nació la entrega de esta cita. */
  connector: string | null;
  meetingLink: string | null;
  /** El proveedor falló al crear la reunión: se puede reintentar. */
  linkPending: boolean;
  isTest: boolean;
  notes: string | null;
};

export async function listBookings(
  organizationId: string
): Promise<BookingListItem[]> {
  const db = getDb();
  const settings = await getSettings(organizationId);

  const rows = await db
    .select({
      booking: schema.booking,
      contactId: schema.contact.id,
      contactName: schema.contact.name,
      serviceId: schema.service.id,
      serviceName: schema.service.name,
      professionalId: schema.professional.id,
      professionalName: schema.professional.name,
    })
    .from(schema.booking)
    .leftJoin(
      schema.contact,
      and(
        eq(schema.booking.contactId, schema.contact.id),
        eq(schema.contact.organizationId, schema.booking.organizationId)
      )
    )
    .leftJoin(
      schema.service,
      and(
        eq(schema.booking.serviceId, schema.service.id),
        eq(schema.service.organizationId, schema.booking.organizationId)
      )
    )
    .leftJoin(
      schema.professional,
      and(
        eq(schema.booking.professionalId, schema.professional.id),
        eq(schema.professional.organizationId, schema.booking.organizationId)
      )
    )
    .where(scoped(schema.booking.organizationId, organizationId))
    .orderBy(desc(schema.booking.scheduledAt))
    .limit(200);

  return rows.map((r) => {
    const scheduledAtUtc = r.booking.scheduledAt.toISOString();
    const parts = partsInTz(scheduledAtUtc, r.booking.timezone || settings.timezone);
    return {
      id: r.booking.id,
      kind: r.booking.kind,
      status: r.booking.status,
      source: r.booking.source,
      scheduledAtUtc,
      durationMinutes: r.booking.durationMinutes,
      date: parts.date,
      time: parts.time,
      weekday: parts.weekday,
      contact: r.contactId
        ? { id: r.contactId, name: r.contactName ?? "" }
        : null,
      service: r.serviceId
        ? { id: r.serviceId, name: r.serviceName ?? "" }
        : null,
      professional: r.professionalId
        ? { id: r.professionalId, name: r.professionalName ?? "" }
        : null,
      conversationId: r.booking.conversationId,
      connector: r.booking.connector,
      meetingLink: r.booking.meetingLink,
      linkPending: r.booking.linkPending,
      isTest: r.booking.isTest,
      notes: r.booking.notes,
    };
  });
}
