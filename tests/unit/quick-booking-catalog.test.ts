import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("agendamiento rápido con catálogo operativo", () => {
  it("muestra la acción sólo cuando la agenda está habilitada", () => {
    const page = source("src/app/(app)/inbox/page.tsx");
    const panel = source("src/components/inbox/contact-panel.tsx");

    expect(page).toContain("agenda={agendaEnabled()}");
    expect(panel).toContain("{agenda && (");
    expect(panel).toContain("Agendar cita");
  });

  it("expone sólo un catálogo mínimo con permiso de crear citas", () => {
    const route = source("src/app/api/calendar/catalog/route.ts");

    expect(route).toContain('withOrgPermissions(["appointments.create"]');
    expect(route).toContain("listServices");
    expect(route).toContain("listProfessionals");
    expect(route).toContain('service.active');
    expect(route).toContain('professional.status === "active"');
    expect(route).not.toContain("professional.email");
    expect(route).not.toContain("professional.phone");
    expect(route).toContain("canConfigureCatalog");
    expect(route).toContain('"settings.read"');
  });

  it("conserva el aislamiento por organización al leer el catálogo", () => {
    const catalog = source("src/server/beauty/catalog.ts");

    expect(catalog).toContain("listServices(organizationId: string)");
    expect(catalog).toContain("listProfessionals(organizationId: string)");
    expect(catalog).toContain("scoped(schema.service.organizationId, organizationId)");
    expect(catalog).toContain(
      "scoped(schema.professional.organizationId, organizationId)"
    );
    expect(catalog).toContain(
      "scoped(schema.professionalService.organizationId, organizationId)"
    );
  });

  it("usa sólo servicios con profesionales aplicables", () => {
    const dialog = source("src/components/inbox/quick-booking-dialog.tsx");

    expect(dialog).toContain("/api/calendar/catalog");
    expect(dialog).toContain("schedulableServices");
    expect(dialog).toContain("professional.serviceIds.includes(service.id)");
    expect(dialog).toContain("availableProfessionals");
    expect(dialog).toContain("professional.serviceIds.includes(serviceId)");
    expect(dialog).toContain("Selecciona un servicio");
    expect(dialog).toContain("Selecciona profesional");
  });

  it("consulta disponibilidad y crea con servicio y profesional", () => {
    const dialog = source("src/components/inbox/quick-booking-dialog.tsx");

    expect(dialog).toContain('params.set("serviceId", serviceId)');
    expect(dialog).toContain('params.set("professionalId", professionalId)');
    expect(dialog).toContain("serviceId,");
    expect(dialog).toContain("professionalId,");
  });

  it("explica cuándo usa la agenda general y enlaza la configuración si procede", () => {
    const dialog = source("src/components/inbox/quick-booking-dialog.tsx");

    expect(dialog).toContain("Cita general");
    expect(dialog).toContain("guardará sin asignar servicio ni profesional.");
    expect(dialog).toContain("catalog.canConfigureCatalog");
    expect(dialog).toContain('href="/settings/beauty"');
    expect(dialog).toContain("Configurar servicios y personal");
  });

  it("asocia el contacto y la conversación sin recargar la página", () => {
    const dialog = source("src/components/inbox/quick-booking-dialog.tsx");
    const route = source("src/app/api/bookings/route.ts");
    const panel = source("src/components/inbox/contact-panel.tsx");

    expect(dialog).toContain("contactId: conversation.contact.id");
    expect(dialog).toContain("conversationId: conversation.id");
    expect(route).toContain("contactId: body.data.contactId");
    expect(route).toContain("conversationId: body.data.conversationId ?? null");
    expect(panel).toContain("void refreshLive()");
  });

  it("maneja carga, falta de horarios, error, confirmación y éxito", () => {
    const dialog = source("src/components/inbox/quick-booking-dialog.tsx");

    expect(dialog).toContain("Cargando agenda…");
    expect(dialog).toContain("No hay horarios disponibles en este momento.");
    expect(dialog).toContain("No se pudo consultar la disponibilidad.");
    expect(dialog).toContain('busy ? "Agendando…" : "Confirmar cita"');
    expect(dialog).toContain("Cita creada");
    expect(dialog).toContain("void refreshSlots()");
  });

  it("mantiene el sheet móvil y el orden reciente del Inbox", () => {
    const dialog = source("src/components/inbox/quick-booking-dialog.tsx");
    const list = source("src/components/inbox/conversation-list.tsx");

    expect(dialog).toContain("items-end");
    expect(dialog).toContain("rounded-t-2xl");
    expect(dialog).toContain("sm:items-center");
    expect(list).toContain("Date.parse(b.lastMessageAt");
    expect(list).toContain("Date.parse(a.lastMessageAt");
  });

  it("protege disponibilidad y creación con permisos de citas", () => {
    const availability = source("src/app/api/calendar/availability/route.ts");
    const bookings = source("src/app/api/bookings/route.ts");

    expect(availability).toContain(
      'withOrgPermissions(\n  ["appointments.create"]'
    );
    expect(bookings).toContain(
      'withOrgPermissions(\n  ["appointments.create"]'
    );
    expect(bookings).toContain(
      'withOrgPermissions(["appointments.read"]'
    );
  });
});
