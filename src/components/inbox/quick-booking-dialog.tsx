"use client";

import { useEffect, useState } from "react";
import { CalendarDays, Check, Clock3, X } from "lucide-react";
import type { ConversationDto } from "@/lib/types";
import { Button } from "@/components/ui/button";

type Slot = {
  startUtc: string;
  label?: string;
  dayLabel?: string;
  time?: string;
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
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function loadSlots() {
    setSlots(null);
    setError(null);
    const res = await fetch("/api/calendar/availability").catch(() => null);
    if (!res?.ok) {
      setSlots([]);
      setError("No se pudo consultar la disponibilidad.");
      return;
    }
    const data = (await res.json()) as { slots: Slot[] };
    setSlots(data.slots.slice(0, 12));
  }

  useEffect(() => {
    void loadSlots();
  }, []);

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
        startUtc: selected,
      }),
    }).catch(() => null);
    setBusy(false);

    if (res?.status !== 201) {
      const data = (await res?.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(data?.error?.message ?? "No se pudo crear la cita.");
      void loadSlots();
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
              <div className="mb-3 flex items-center gap-2 text-sm text-text-2">
                <CalendarDays className="h-4 w-4 text-brand" strokeWidth={1.8} />
                <span>Elige un horario disponible</span>
              </div>

              {slots === null && (
                <p className="rounded-lg bg-subtle p-4 text-sm text-text-3">
                  Consultando disponibilidad…
                </p>
              )}

              {slots?.length === 0 && !error && (
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
                onClick={() => void loadSlots()}
                className="text-xs font-semibold text-text-3 hover:text-foreground"
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
