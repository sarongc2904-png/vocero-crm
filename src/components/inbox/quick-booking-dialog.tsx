"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Check, Clock3, X } from "lucide-react";
import type { ConversationDto } from "@/lib/types";
import { Button } from "@/components/ui/button";

type Slot = {
  startUtc: string;
  label?: string;
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
  services: BookingService[];
  professionals: BookingProfessional[];
};

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
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const structuredBooking = Boolean(
    catalog && catalog.services.length > 0 && catalog.professionals.length > 0
  );

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

      if (data.services.length === 1) {
        const onlyService = data.services[0]!;
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

    const hasStructuredCatalog =
      catalog.services.length > 0 && catalog.professionals.length > 0;

    if (hasStructuredCatalog && (!serviceId || !professionalId)) {
      setSlots([]);
      setSelected(null);
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
      setSlots(data.slots.slice(0, 12));
    })();

    return () => {
      cancelled = true;
    };
  }, [catalog, serviceId, professionalId]);

  function chooseService(nextServiceId: string) {
    setServiceId(nextServiceId);
    setProfessionalId("");

    const matching =
      catalog?.professionals.filter((professional) =>
        professional.serviceIds.includes(nextServiceId)
      ) ?? [];
    if (matching.length === 1) setProfessionalId(matching[0]!.id);
  }

  async function refreshSlots() {
    if (!catalog) return;
    if (structuredBooking && (!serviceId || !professionalId)) return;

    setSlots(null);
    setSelected(null);
    setError(null);

    const params = new URLSearchParams();
    if (structuredBooking) {
      params.set("serviceId", serviceId);
      params.set("professionalId", professionalId);
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
    setSlots(data.slots.slice(0, 12));
  }

  async function confirm() {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);

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
        error?: { message?: string };
      } | null;
      setError(data?.error?.message ?? "No se pudo crear la cita.");
      void refreshSlots();
      return;
    }

    setDone(true);
    onBooked();
  }

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
                      {catalog!.services.map((service) => (
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
                      onChange={(e) => setProfessionalId(e.target.value)}
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
                  {structuredBooking && (!serviceId || !professionalId)
                    ? "Elige servicio y profesional"
                    : "Elige un horario disponible"}
                </span>
              </div>

              {catalog === null && !error && (
                <p className="rounded-lg bg-subtle p-4 text-sm text-text-3">
                  Cargando agenda…
                </p>
              )}

              {catalog && slots === null && (
                <p className="rounded-lg bg-subtle p-4 text-sm text-text-3">
                  Consultando disponibilidad…
                </p>
              )}

              {slots?.length === 0 &&
                !error &&
                (!structuredBooking || (serviceId && professionalId)) && (
                  <p className="rounded-lg bg-subtle p-4 text-sm text-text-3">
                    No hay horarios disponibles en este momento.
                  </p>
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

              {error && (
                <div className="mt-3 rounded-lg border border-danger-soft bg-danger-tint px-3 py-2.5 text-sm text-danger-text">
                  {error}
                </div>
              )}
            </div>

            <footer className="flex items-center justify-between gap-2 border-t px-4 py-3">
              <button
                type="button"
                disabled={structuredBooking && (!serviceId || !professionalId)}
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
