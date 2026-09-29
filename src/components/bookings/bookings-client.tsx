"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEvents } from "@/components/use-events";

/** 015 — Citas: lo agendado por el operador y por la IA, con sus acciones. */

type Booking = {
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
  connector: string | null;
  meetingLink: string | null;
  linkPending: boolean;
  isTest: boolean;
  notes: string | null;
};

type Slot = { startUtc: string; label: string; dayIso?: string };

/** Suma días a un `YYYY-MM-DD` sin depender de la zona del navegador. */
function shiftIsoDay(iso: string, delta: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function slotDay(slot: Slot): string {
  return slot.dayIso ?? slot.startUtc.slice(0, 10);
}

const STATUS_LABEL: Record<Booking["status"], string> = {
  agendada: "Agendada",
  realizada: "Realizada",
  no_show: "No asistió",
  cancelada: "Cancelada",
};

export function BookingsClient() {
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState<string | null>(null);
  /**
   * QB-06: la disponibilidad de reprogramación es POR CITA. Antes se usaba la
   * rejilla general para todas, así que mover una cita con profesional ofrecía
   * huecos que el servidor revalidaba contra el calendario de ese profesional y
   * respondía 409 sobre un horario que la propia UI acababa de mostrar libre.
   */
  const [rescheduleSlots, setRescheduleSlots] = useState<Slot[] | null>(null);
  const [rescheduleDay, setRescheduleDay] = useState<string | null>(null);
  const [rescheduleError, setRescheduleError] = useState<string | null>(null);
  const [blockStart, setBlockStart] = useState("");
  const [blockMinutes, setBlockMinutes] = useState(60);
  const [showBlockForm, setShowBlockForm] = useState(false);

  useEffect(() => {
    void refresh();
  }, []);

  // La agenda cambia también cuando agenda la IA: SSE mantiene la vista viva.
  useEvents({ onBookingUpdated: () => void refresh() });

  async function refresh() {
    // QB-06: la vista ya NO precarga una rejilla general —la disponibilidad se
    // pide por cita al abrir "Reprogramar"—, así que aquí solo se lista.
    const list = await fetch("/api/bookings").catch(() => null);
    if (list?.ok) {
      const data = (await list.json()) as { bookings: Booking[] };
      setBookings(data.bookings);
    } else {
      setBookings([]);
    }
  }

  async function act(id: string, body: unknown) {
    setBusy(id);
    setError(null);
    const res = await fetch(`/api/bookings/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      const data = (await res?.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(data?.error?.message ?? "No se pudo completar la acción");
      return;
    }
    setRescheduling(null);
    await refresh();
  }

  /**
   * QB-06 — Disponibilidad DERIVADA DE LA CITA.
   *
   * Si la cita tiene servicio y profesional, se consulta ESA combinación (el
   * servidor revalida contra el calendario del profesional y aplica los
   * bloqueos y la duración del servicio). Una cita general —sin profesional—
   * usa la rejilla general, que es su caso legítimo.
   */
  async function loadRescheduleSlots(booking: Booking, day: string | null) {
    setRescheduleSlots(null);
    setRescheduleError(null);

    const params = new URLSearchParams();
    if (booking.service?.id && booking.professional?.id) {
      params.set("serviceId", booking.service.id);
      params.set("professionalId", booking.professional.id);
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
      setRescheduleSlots([]);
      setRescheduleError("No se pudo consultar la disponibilidad de esta cita.");
      return;
    }

    const data = (await res.json()) as { slots: Slot[] };
    if (!day) {
      const first = data.slots[0];
      if (!first) {
        setRescheduleSlots([]);
        return;
      }
      const firstDay = slotDay(first);
      setRescheduleDay(firstDay);
      setRescheduleSlots(
        data.slots.filter((slot) => slotDay(slot) === firstDay)
      );
      return;
    }
    setRescheduleSlots(data.slots);
  }

  function openReschedule(booking: Booking) {
    setRescheduling(booking.id);
    setRescheduleDay(null);
    void loadRescheduleSlots(booking, null);
  }

  async function createBlock() {
    if (!blockStart) return;
    setError(null);
    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "block",
        // El input datetime-local da hora local del navegador.
        startUtc: new Date(blockStart).toISOString(),
        durationMinutes: blockMinutes,
      }),
    }).catch(() => null);
    if (res?.status !== 201) {
      const data = (await res?.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(data?.error?.message ?? "No se pudo bloquear ese rango");
      return;
    }
    setBlockStart("");
    await refresh();
  }

  if (!bookings) return <p className="text-sm text-text-3">Cargando…</p>;

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">
          Citas <span className="text-text-3">({bookings.length})</span>
        </h3>
        {bookings.length === 0 && (
          <p className="text-sm text-text-3">
            Todavía no hay citas. Puedes crear una desde Mensajes → Agendar cita o
            configurar tu horario en Ajustes → Agenda.
          </p>
        )}
        <ul className="divide-y rounded-md border">
          {bookings.map((b) => (
            <li key={b.id} className="space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">
                  {b.weekday} {b.date} · {b.time}
                </span>
                <span className="text-xs text-text-3">
                  {b.durationMinutes} min
                </span>
                <Badge
                  variant={b.status === "cancelada" ? "secondary" : "default"}
                >
                  {STATUS_LABEL[b.status]}
                </Badge>
                {b.kind === "block" ? (
                  <Badge variant="secondary">Bloqueo</Badge>
                ) : (
                  <Badge variant="secondary">
                    {b.source === "ai" ? "Agendó la IA" : "Manual"}
                  </Badge>
                )}
                {b.isTest && <Badge variant="secondary">Prueba</Badge>}
                {b.linkPending && b.status !== "cancelada" && (
                  <Badge variant="secondary">Sin enlace</Badge>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3 text-sm text-text-3">
                {b.contact && <span>{b.contact.name}</span>}
                {b.service && <span>{b.service.name}</span>}
                {b.professional && <span>con {b.professional.name}</span>}
                {b.meetingLink && (
                  <a
                    href={b.meetingLink}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-brand-text hover:underline"
                  >
                    Enlace de la reunión
                  </a>
                )}
                {b.notes && <span>{b.notes}</span>}
              </div>

              {/* El proveedor falló al crear la reunión. La cita existe; lo
                  único que falta es el enlace, y se reintenta desde aquí — sin
                  esto, un hipo del proveedor sería una pérdida silenciosa. */}
              {b.linkPending && b.status !== "cancelada" && (
                <div className="flex flex-wrap items-center gap-2 rounded-sm bg-subtle p-2">
                  <span className="text-sm text-text-2">
                    Esta cita quedó sin enlace: el proveedor no respondió.
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy === b.id}
                    onClick={() => act(b.id, { action: "retry_link" })}
                  >
                    Reintentar enlace
                  </Button>
                </div>
              )}

              {b.status === "agendada" && (
                <div className="flex flex-wrap gap-2">
                  {/* Un bloqueo no se "realiza" ni tiene quien falte: solo se
                      mueve o se quita. */}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy === b.id}
                    onClick={() =>
                      rescheduling === b.id
                        ? setRescheduling(null)
                        : openReschedule(b)
                    }
                  >
                    Reprogramar
                  </Button>
                  {b.kind === "session" && (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy === b.id}
                        onClick={() =>
                          act(b.id, { action: "status", status: "realizada" })
                        }
                      >
                        Realizada
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy === b.id}
                        onClick={() =>
                          act(b.id, { action: "status", status: "no_show" })
                        }
                      >
                        No asistió
                      </Button>
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === b.id}
                    onClick={() => act(b.id, { action: "cancel" })}
                  >
                    {b.kind === "block" ? "Quitar bloqueo" : "Cancelar"}
                  </Button>
                </div>
              )}

              {rescheduling === b.id && (
                <div className="space-y-2 rounded-sm bg-subtle p-2">
                  <p className="text-xs text-text-3">
                    {b.professional
                      ? `Horarios de ${b.professional.name}${
                          b.service ? ` · ${b.service.name}` : ""
                        }`
                      : "Horarios generales del negocio"}
                  </p>

                  {rescheduleDay && (
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          const next = shiftIsoDay(rescheduleDay, -1);
                          setRescheduleDay(next);
                          void loadRescheduleSlots(b, next);
                        }}
                        className="text-xs font-semibold text-text-3 hover:text-foreground"
                      >
                        ← Día anterior
                      </button>
                      <span className="text-xs font-semibold">{rescheduleDay}</span>
                      <button
                        type="button"
                        onClick={() => {
                          const next = shiftIsoDay(rescheduleDay, 1);
                          setRescheduleDay(next);
                          void loadRescheduleSlots(b, next);
                        }}
                        className="text-xs font-semibold text-text-3 hover:text-foreground"
                      >
                        Día siguiente →
                      </button>
                    </div>
                  )}

                  {rescheduleSlots === null && (
                    <p className="text-sm text-text-3">
                      Consultando disponibilidad…
                    </p>
                  )}

                  {rescheduleSlots?.length === 0 && !rescheduleError && (
                    <p className="text-sm text-text-3">
                      No hay huecos libres para mover esta cita.
                    </p>
                  )}

                  {rescheduleError && (
                    <p className="text-sm text-destructive">{rescheduleError}</p>
                  )}

                  {rescheduleSlots?.map((s) => (
                    <button
                      key={s.startUtc}
                      type="button"
                      disabled={busy === b.id}
                      onClick={() =>
                        act(b.id, {
                          action: "reschedule",
                          startUtc: s.startUtc,
                        })
                      }
                      className="block w-full rounded-sm px-2 py-1 text-left text-sm hover:bg-accent"
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="space-y-2">
        <button
          type="button"
          onClick={() => setShowBlockForm((value) => !value)}
          className="text-sm font-semibold text-text-2 hover:text-foreground"
        >
          {showBlockForm ? "Ocultar bloqueo de horario" : "+ Bloquear un horario"}
        </button>
        {showBlockForm && (
          <div className="rounded-md border bg-subtle/40 p-4">
            <p className="mb-3 text-sm text-text-3">
              Úsalo para compromisos externos, comidas o cualquier periodo que no
              quieras ofrecer como disponible.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="block-start">Inicio</Label>
                <Input
                  id="block-start"
                  type="datetime-local"
                  value={blockStart}
                  onChange={(e) => setBlockStart(e.target.value)}
                  className="w-56"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="block-min">Duración (min)</Label>
                <Input
                  id="block-min"
                  type="number"
                  min={10}
                  max={480}
                  value={blockMinutes}
                  onChange={(e) => setBlockMinutes(Number(e.target.value))}
                  className="w-28"
                />
              </div>
              <Button
                variant="secondary"
                onClick={createBlock}
                disabled={!blockStart}
              >
                Bloquear horario
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
