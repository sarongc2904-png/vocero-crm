"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, X } from "lucide-react";
import type { ConversationDto } from "@/lib/types";
import { Button } from "@/components/ui/button";

type Slot = {
  startUtc: string;
  label?: string;
  dayIso?: string;
  dayLabel?: string;
  time?: string;
};

type BookingService = {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
  currency: string;
};

type BookingProfessional = {
  id: string;
  name: string;
  serviceIds: string[];
};

type BookingCatalog = {
  canConfigureCatalog: boolean;
  services: BookingService[];
  professionals: BookingProfessional[];
};

/** Cuántos días hacia adelante busca el botón "siguiente día disponible". */
const MAX_DAY_SEARCH = 30;

/** Suma días a un `YYYY-MM-DD` sin depender de la zona del navegador. */
function shiftIsoDay(iso: string, delta: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/** Día en palabras ("viernes, 3 de octubre"). */
function dayLabelFor(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toLocaleDateString("es-MX", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/** El día (en la zona del negocio) al que pertenece un slot. */
function slotDay(slot: Slot): string {
  return slot.dayIso ?? slot.startUtc.slice(0, 10);
}

export function QuickBookingDialog({
  conversation,
  onClose,
  onBooked,
}: {
  conversation: ConversationDto;
  onClose: () => void;
  onBooked: () => void;
}) {
  const [catalog, setCatalog] = useState<BookingCatalog | null>(null);
  const [serviceId, setServiceId] = useState("");
  const [professionalId, setProfessionalId] = useState("");
  const [slots, setSlots] = useState<Slot[] | null>(null);
  /** QB-07: día mostrado (YYYY-MM-DD). `null` = descubrir el primero con huecos. */
  const [day, setDay] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * QB-01: el error de creación es independiente del de carga. Antes ambos eran
   * el mismo estado y el `refreshSlots()` posterior al 409 lo borraba en el
   * mismo tick, así que el operador nunca veía por qué falló.
   */
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [noMoreDays, setNoMoreDays] = useState(false);
  const [done, setDone] = useState(false);

  const schedulableServices = useMemo(
    () =>
      catalog?.services.filter((service) =>
        catalog.professionals.some((professional) =>
          professional.serviceIds.includes(service.id)
        )
      ) ?? [],
    [catalog]
  );
  const structuredBooking = schedulableServices.length > 0;

  const availableProfessionals = useMemo(
    () =>
      serviceId && catalog
        ? catalog.professionals.filter((professional) =>
            professional.serviceIds.includes(serviceId)
          )
        : [],
    [catalog, serviceId]
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const res = await fetch("/api/calendar/catalog").catch(() => null);
      if (cancelled) return;

      if (!res?.ok) {
        setCatalog(null);
        setSlots([]);
        setError("No se pudo cargar la configuración de agenda.");
        return;
      }

      const data = (await res.json()) as BookingCatalog;
      if (cancelled) return;

      setCatalog(data);

      const schedulable = data.services.filter((service) =>
        data.professionals.some((professional) =>
          professional.serviceIds.includes(service.id)
        )
      );
      if (schedulable.length === 1) {
        const onlyService = schedulable[0]!;
        setServiceId(onlyService.id);
        const matching = data.professionals.filter((professional) =>
          professional.serviceIds.includes(onlyService.id)
        );
        if (matching.length === 1) setProfessionalId(matching[0]!.id);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!catalog) return;

    const hasStructuredCatalog = schedulableServices.length > 0;

    if (hasStructuredCatalog && (!serviceId || !professionalId)) {
      setSlots([]);
      setSelected(null);
      setDay(null);
      return;
    }

    let cancelled = false;
    setSlots(null);
    setSelected(null);
    setError(null);

    void (async () => {
      const params = new URLSearchParams();
      if (hasStructuredCatalog) {
        params.set("serviceId", serviceId);
        params.set("professionalId", professionalId);
      }
      // QB-07: con un día elegido se consulta SOLO ese día; sin él, la ventana
      // por defecto sirve para descubrir el primer día con huecos.
      if (day) {
        params.set("from", day);
        params.set("to", day);
      }
      const query = params.size > 0 ? `?${params.toString()}` : "";
      const res = await fetch(`/api/calendar/availability${query}`).catch(
        () => null
      );
      if (cancelled) return;

      if (!res?.ok) {
        setSlots([]);
        setError("No se pudo consultar la disponibilidad.");
        return;
      }

      const data = (await res.json()) as { slots: Slot[] };
      if (cancelled) return;

      if (!day) {
        const first = data.slots[0];
        if (!first) {
          setSlots([]);
          return;
        }
        const firstDay = slotDay(first);
        setDay(firstDay);
        setSlots(data.slots.filter((slot) => slotDay(slot) === firstDay));
        return;
      }

      setSlots(data.slots);
    })();

    return () => {
      cancelled = true;
    };
  }, [catalog, day, professionalId, schedulableServices.length, serviceId]);

  function chooseService(nextServiceId: string) {
    setServiceId(nextServiceId);
    setProfessionalId("");
    setDay(null);
    setActionError(null);

    const matching =
      catalog?.professionals.filter((professional) =>
        professional.serviceIds.includes(nextServiceId)
      ) ?? [];
    if (matching.length === 1) setProfessionalId(matching[0]!.id);
  }

  function chooseProfessional(nextProfessionalId: string) {
    setProfessionalId(nextProfessionalId);
    setDay(null);
    setActionError(null);
  }

  /** QB-07: navegar a un día concreto (anterior/siguiente o búsqueda). */
  function selectDay(next: string) {
    setSelected(null);
    setActionError(null);
    setNoMoreDays(false);
    setDay(next);
  }

  /** QB-07: avanzar hasta el primer día con huecos, acotado. */
  async function findNextAvailableDay() {
    if (!day || searching) return;
    setSearching(true);
    setActionError(null);

    const base = new URLSearchParams();
    if (structuredBooking) {
      base.set("serviceId", serviceId);
      base.set("professionalId", professionalId);
    }

    for (let offset = 1; offset <= MAX_DAY_SEARCH; offset += 1) {
      const candidate = shiftIsoDay(day, offset);
      const params = new URLSearchParams(base);
      params.set("from", candidate);
      params.set("to", candidate);
      const res = await fetch(
        `/api/calendar/availability?${params.toString()}`
      ).catch(() => null);
      if (res?.ok) {
        const data = (await res.json()) as { slots: Slot[] };
        if (data.slots.length > 0) {
          setSearching(false);
          selectDay(candidate);
          return;
        }
      }
    }

    setSearching(false);
    setNoMoreDays(true);
  }

  async function refreshSlots() {
    if (!catalog) return;
    if (structuredBooking && (!serviceId || !professionalId)) return;

    // QB-01: NO se limpia `actionError` aquí. Un 409 debe seguir visible
    // después de refrescar la lista de huecos.
    setSelected(null);

    const params = new URLSearchParams();
    if (structuredBooking) {
      params.set("serviceId", serviceId);
      params.set("professionalId", professionalId);
    }
    if (day) {
      params.set("from", day);
      params.set("to", day);
    }
    const query = params.size > 0 ? `?${params.toString()}` : "";
    const res = await fetch(`/api/calendar/availability${query}`).catch(
      () => null
    );

    if (!res?.ok) {
      setSlots([]);
      setError("No se pudo consultar la disponibilidad.");
      return;
    }

    const data = (await res.json()) as { slots: Slot[] };
    setSlots(day ? data.slots : data.slots.slice(0, 12));
  }

  async function confirm() {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    setActionError(null);

    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "session",
        contactId: conversation.contact.id,
        conversationId: conversation.id,
        ...(structuredBooking
          ? {
              serviceId,
              professionalId,
            }
          : {}),
        startUtc: selected,
      }),
    }).catch(() => null);

    setBusy(false);

    if (res?.status !== 201) {
      const data = (await res?.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      // QB-01: ante un choque de hueco el operador tiene que entender qué pasó.
      setActionError(
        res?.status === 409 || data?.error?.code === "slot_taken"
          ? "Ese horario acaba de ocuparse. Elige otro."
          : data?.error?.message ?? "No se pudo crear la cita."
      );
      void refreshSlots();
      return;
    }

    setDone(true);
    onBooked();
  }

  const visibleError = actionError ?? error;
  const canPickSlot =
    !structuredBooking || Boolean(serviceId && professionalId);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-overlay p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Agendar cita"
      onClick={onClose}
    >
      <div
        className="max-h-[88dvh] w-full overflow-hidden rounded-t-2xl border bg-background shadow-pop sm:max-w-lg sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <p className="text-sm font-bold">Agendar cita</p>
            <p className="text-xs text-text-3">{conversation.contact.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-md p-1.5 text-text-3 hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </header>

        {done ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-tint text-brand-text">
              <Check className="h-5 w-5" strokeWidth={2.2} />
            </span>
            <div>
              <p className="font-semibold">Cita creada</p>
              <p className="mt-1 text-sm text-text-3">
                Quedó asociada a esta conversación y al cliente.
              </p>
            </div>
            <Button onClick={onClose}>Listo</Button>
          </div>
        ) : (
          <>
            <div className="max-h-[60dvh] overflow-y-auto p-4">
              {catalog && !structuredBooking && (
                <div className="mb-4 rounded-lg border border-warning-soft bg-warning-tint px-3 py-3 text-sm text-warning-text">
                  <p className="font-semibold">Cita general</p>
                  <p className="mt-1 text-xs">
                    No hay un servicio con profesional disponible. La cita se
                    guardará sin asignar servicio ni profesional.
                  </p>
                  {catalog.canConfigureCatalog && (
                    <Link
                      href="/settings/beauty"
                      onClick={onClose}
                      className="mt-2 inline-flex text-xs font-semibold underline underline-offset-2"
                    >
                      Configurar servicios y personal →
                    </Link>
                  )}
                </div>
              )}

              {structuredBooking && (
                <div className="mb-4 grid gap-3 sm:grid-cols-2">
                  <label className="text-xs font-semibold text-text-2">
                    Servicio
                    <select
                      value={serviceId}
                      onChange={(e) => chooseService(e.target.value)}
                      className="mt-1.5 h-10 w-full rounded-md border border-border-strong bg-background px-3 text-sm"
                    >
                      <option value="">Selecciona un servicio</option>
                      {schedulableServices.map((service) => (
                        <option key={service.id} value={service.id}>
                          {service.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="text-xs font-semibold text-text-2">
                    Profesional
                    <select
                      value={professionalId}
                      disabled={!serviceId}
                      onChange={(e) => chooseProfessional(e.target.value)}
                      className="mt-1.5 h-10 w-full rounded-md border border-border-strong bg-background px-3 text-sm disabled:opacity-50"
                    >
                      <option value="">
                        {serviceId ? "Selecciona profesional" : "Primero el servicio"}
                      </option>
                      {availableProfessionals.map((professional) => (
                        <option key={professional.id} value={professional.id}>
                          {professional.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}

              <div className="mb-3 flex items-center gap-2 text-sm text-text-2">
                <CalendarDays className="h-4 w-4 text-brand" strokeWidth={1.8} />
                <span>
                  {!canPickSlot
                    ? "Elige servicio y profesional"
                    : day
                      ? "Elige un horario de ese día"
                      : "Elige un horario disponible"}
                </span>
              </div>

              {/* QB-07: navegación por día, sin volcar la semana completa. */}
              {canPickSlot && day && (
                <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border bg-subtle px-2 py-2">
                  <button
                    type="button"
                    onClick={() => selectDay(shiftIsoDay(day, -1))}
                    aria-label="Día anterior"
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-text-3 hover:bg-accent hover:text-foreground"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
                    Anterior
                  </button>
                  <span className="text-xs font-semibold capitalize">
                    {dayLabelFor(day)}
                  </span>
                  <button
                    type="button"
                    onClick={() => selectDay(shiftIsoDay(day, 1))}
                    aria-label="Día siguiente"
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-text-3 hover:bg-accent hover:text-foreground"
                  >
                    Siguiente
                    <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} />
                  </button>
                </div>
              )}

              {catalog === null && !visibleError && (
                <p className="rounded-lg bg-subtle p-4 text-sm text-text-3">
                  Cargando agenda…
                </p>
              )}

              {catalog && slots === null && (
                <p className="rounded-lg bg-subtle p-4 text-sm text-text-3">
                  Consultando disponibilidad…
                </p>
              )}

              {slots?.length === 0 && !visibleError && canPickSlot && (
                <div className="rounded-lg bg-subtle p-4 text-sm text-text-3">
                  {day ? (
                    <>
                      <p className="font-semibold text-text-2">
                        Sin disponibilidad este día.
                      </p>
                      <p className="mt-1 text-xs">
                        No hay horarios libres para {dayLabelFor(day)}.
                      </p>
                      {noMoreDays ? (
                        <p className="mt-2 text-xs font-semibold">
                          No encontré más días con disponibilidad en el rango
                          configurado.
                        </p>
                      ) : (
                        <button
                          type="button"
                          disabled={searching}
                          onClick={() => void findNextAvailableDay()}
                          className="mt-2 text-xs font-semibold underline underline-offset-2 disabled:opacity-50"
                        >
                          {searching
                            ? "Buscando el siguiente día…"
                            : "Buscar el siguiente día disponible"}
                        </button>
                      )}
                    </>
                  ) : (
                    "No hay horarios disponibles en este momento."
                  )}
                </div>
              )}

              {slots && slots.length > 0 && (
                <div className="grid gap-2 sm:grid-cols-2">
                  {slots.map((slot) => {
                    const active = selected === slot.startUtc;
                    return (
                      <button
                        key={slot.startUtc}
                        type="button"
                        onClick={() => setSelected(slot.startUtc)}
                        className={
                          "rounded-lg border px-3 py-3 text-left transition-colors " +
                          (active
                            ? "border-brand bg-brand-tint text-brand-text"
                            : "border-border-strong bg-background hover:bg-accent")
                        }
                      >
                        <span className="block text-sm font-semibold">
                          {slot.dayLabel ?? slot.label ?? "Horario disponible"}
                        </span>
                        <span className="mt-1 inline-flex items-center gap-1 text-xs text-text-3">
                          <Clock3 className="h-3.5 w-3.5" strokeWidth={1.7} />
                          {slot.time ??
                            new Date(slot.startUtc).toLocaleTimeString("es-MX", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {visibleError && (
                <div className="mt-3 rounded-lg border border-danger-soft bg-danger-tint px-3 py-2.5 text-sm text-danger-text">
                  {visibleError}
                </div>
              )}
            </div>

            <footer className="flex items-center justify-between gap-2 border-t px-4 py-3">
              <button
                type="button"
                disabled={!canPickSlot}
                onClick={() => void refreshSlots()}
                className="text-xs font-semibold text-text-3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                Actualizar horarios
              </button>
              <Button disabled={!selected || busy} onClick={() => void confirm()}>
                {busy ? "Agendando…" : "Confirmar cita"}
              </Button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
