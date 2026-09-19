"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Service = {
  id: string;
  name: string;
  category: string | null;
  durationMinutes: number;
  priceCents: number;
  currency: string;
  active: boolean;
};

type Professional = {
  id: string;
  name: string;
  status: "active" | "inactive";
  timezone: string;
  serviceIds: string[];
};

type Day = {
  dayOfWeek: number;
  label: string;
  enabled: boolean;
  start: string;
  end: string;
};

const DEFAULT_DAYS: Day[] = [
  { dayOfWeek: 1, label: "Lunes", enabled: true, start: "09:00", end: "18:00" },
  { dayOfWeek: 2, label: "Martes", enabled: true, start: "09:00", end: "18:00" },
  { dayOfWeek: 3, label: "Miércoles", enabled: true, start: "09:00", end: "18:00" },
  { dayOfWeek: 4, label: "Jueves", enabled: true, start: "09:00", end: "18:00" },
  { dayOfWeek: 5, label: "Viernes", enabled: true, start: "09:00", end: "18:00" },
  { dayOfWeek: 6, label: "Sábado", enabled: true, start: "09:00", end: "14:00" },
  { dayOfWeek: 0, label: "Domingo", enabled: false, start: "09:00", end: "14:00" },
];

const toMinute = (value: string) => {
  const [hour = "0", minute = "0"] = value.split(":");
  return Number(hour) * 60 + Number(minute);
};

const toTime = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

export function BeautySettingsClient() {
  const [services, setServices] = useState<Service[]>([]);
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [serviceName, setServiceName] = useState("");
  const [category, setCategory] = useState("");
  const [duration, setDuration] = useState(60);
  const [price, setPrice] = useState("");
  const [professionalName, setProfessionalName] = useState("");
  const [timezone, setTimezone] = useState("America/Mexico_City");
  const [selectedServices, setSelectedServices] = useState<string[]>([]);
  const [selectedProfessional, setSelectedProfessional] = useState("");
  const [days, setDays] = useState<Day[]>(DEFAULT_DAYS);
  const [timeOffStart, setTimeOffStart] = useState("");
  const [timeOffEnd, setTimeOffEnd] = useState("");
  const [timeOffReason, setTimeOffReason] = useState("");
  const [timeOff, setTimeOff] = useState<
    Array<{ startsAt: string; endsAt: string; reason: string | null }>
  >([]);
  const [message, setMessage] = useState<string | null>(null);

  const activeServices = useMemo(
    () => services.filter((service) => service.active),
    [services]
  );

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    const [serviceResponse, professionalResponse] = await Promise.all([
      fetch("/api/services"),
      fetch("/api/professionals"),
    ]);
    if (serviceResponse.ok) {
      const data = (await serviceResponse.json()) as { services: Service[] };
      setServices(data.services);
    }
    if (professionalResponse.ok) {
      const data = (await professionalResponse.json()) as {
        professionals: Professional[];
      };
      setProfessionals(data.professionals);
    }
  }

  async function createService() {
    setMessage(null);
    const priceCents = Math.round(Number(price) * 100);
    const response = await fetch("/api/services", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: serviceName,
        category: category || null,
        durationMinutes: duration,
        priceCents,
        currency: "MXN",
      }),
    });
    if (!response.ok) return setMessage(await errorMessage(response));
    setServiceName("");
    setCategory("");
    setPrice("");
    setMessage("Servicio guardado");
    await refresh();
  }

  async function createProfessional() {
    setMessage(null);
    const response = await fetch("/api/professionals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: professionalName,
        timezone,
        serviceIds: selectedServices,
      }),
    });
    if (!response.ok) return setMessage(await errorMessage(response));
    const data = (await response.json()) as { professional: Professional };
    setProfessionalName("");
    setSelectedServices([]);
    setSelectedProfessional(data.professional.id);
    setMessage("Profesional guardada. Configura ahora su horario.");
    await refresh();
  }

  async function loadAvailability(professionalId: string) {
    setSelectedProfessional(professionalId);
    setMessage(null);
    if (!professionalId) return;
    const response = await fetch(
      `/api/professionals/${professionalId}/availability`
    );
    if (!response.ok) return setMessage(await errorMessage(response));
    const data = (await response.json()) as {
      availability: {
        weekly: Array<{ dayOfWeek: number; startMinute: number; endMinute: number }>;
        timeOff: Array<{ startsAt: string; endsAt: string; reason: string | null }>;
      };
    };
    setDays(
      DEFAULT_DAYS.map((day) => {
        const interval = data.availability.weekly.find(
          (item) => item.dayOfWeek === day.dayOfWeek
        );
        return interval
          ? {
              ...day,
              enabled: true,
              start: toTime(interval.startMinute),
              end: toTime(interval.endMinute),
            }
          : { ...day, enabled: false };
      })
    );
    setTimeOff(
      data.availability.timeOff.map((item) => ({
        startsAt: new Date(item.startsAt).toISOString(),
        endsAt: new Date(item.endsAt).toISOString(),
        reason: item.reason,
      }))
    );
  }

  function addTimeOff() {
    if (!timeOffStart || !timeOffEnd) return;
    setTimeOff((current) => [
      ...current,
      {
        startsAt: new Date(timeOffStart).toISOString(),
        endsAt: new Date(timeOffEnd).toISOString(),
        reason: timeOffReason.trim() || null,
      },
    ]);
    setTimeOffStart("");
    setTimeOffEnd("");
    setTimeOffReason("");
  }

  async function saveAvailability() {
    if (!selectedProfessional) return;
    const response = await fetch(
      `/api/professionals/${selectedProfessional}/availability`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          weekly: days
            .filter((day) => day.enabled)
            .map((day) => ({
              dayOfWeek: day.dayOfWeek,
              startMinute: toMinute(day.start),
              endMinute: toMinute(day.end),
            })),
          breaks: [],
          timeOff,
        }),
      }
    );
    setMessage(
      response.ok ? "Horario guardado" : await errorMessage(response)
    );
  }

  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Servicios</CardTitle>
          <CardDescription>
            Precio y duración que usarán el CRM y la IA. No se generan desde el
            texto de una conversación.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nombre">
              <Input value={serviceName} onChange={(event) => setServiceName(event.target.value)} />
            </Field>
            <Field label="Categoría">
              <Input value={category} onChange={(event) => setCategory(event.target.value)} />
            </Field>
            <Field label="Duración (minutos)">
              <Input type="number" min={5} value={duration} onChange={(event) => setDuration(Number(event.target.value))} />
            </Field>
            <Field label="Precio (MXN)">
              <Input type="number" min={0} step="0.01" value={price} onChange={(event) => setPrice(event.target.value)} />
            </Field>
          </div>
          <Button disabled={!serviceName.trim() || !price} onClick={createService}>
            Agregar servicio
          </Button>
          <ul className="divide-y rounded-md border text-sm">
            {services.map((service) => (
              <li key={service.id} className="flex justify-between gap-3 p-3">
                <span>{service.name} · {service.durationMinutes} min</span>
                <span>${(service.priceCents / 100).toLocaleString("es-MX")} {service.currency}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Profesionales</CardTitle>
          <CardDescription>
            Asigna únicamente los servicios que cada persona puede realizar.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nombre">
              <Input value={professionalName} onChange={(event) => setProfessionalName(event.target.value)} />
            </Field>
            <Field label="Zona horaria">
              <Input value={timezone} onChange={(event) => setTimezone(event.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-3">
            {activeServices.map((service) => (
              <label key={service.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedServices.includes(service.id)}
                  onChange={() =>
                    setSelectedServices((current) =>
                      current.includes(service.id)
                        ? current.filter((id) => id !== service.id)
                        : [...current, service.id]
                    )
                  }
                />
                {service.name}
              </label>
            ))}
          </div>
          <Button disabled={!professionalName.trim() || selectedServices.length === 0} onClick={createProfessional}>
            Agregar profesional
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Horario, descansos y ausencias</CardTitle>
          <CardDescription>
            Los días cerrados y vacaciones se excluyen programáticamente de la
            disponibilidad real.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <select
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={selectedProfessional}
            onChange={(event) => void loadAvailability(event.target.value)}
          >
            <option value="">Selecciona una profesional</option>
            {professionals.map((professional) => (
              <option key={professional.id} value={professional.id}>{professional.name}</option>
            ))}
          </select>
          {selectedProfessional && (
            <>
              <div className="space-y-2">
                {days.map((day, index) => (
                  <div key={day.dayOfWeek} className="flex flex-wrap items-center gap-2">
                    <label className="flex w-28 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={day.enabled}
                        onChange={(event) =>
                          setDays((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, enabled: event.target.checked } : item))
                        }
                      />
                      {day.label}
                    </label>
                    <Input className="w-32" type="time" disabled={!day.enabled} value={day.start} onChange={(event) => setDays((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, start: event.target.value } : item))} />
                    <span className="text-sm text-text-3">a</span>
                    <Input className="w-32" type="time" disabled={!day.enabled} value={day.end} onChange={(event) => setDays((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, end: event.target.value } : item))} />
                  </div>
                ))}
              </div>
              <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
                <Field label="Ausencia desde">
                  <Input type="datetime-local" value={timeOffStart} onChange={(event) => setTimeOffStart(event.target.value)} />
                </Field>
                <Field label="Hasta">
                  <Input type="datetime-local" value={timeOffEnd} onChange={(event) => setTimeOffEnd(event.target.value)} />
                </Field>
                <Field label="Motivo">
                  <Input value={timeOffReason} onChange={(event) => setTimeOffReason(event.target.value)} />
                </Field>
                <div className="flex items-end"><Button variant="secondary" onClick={addTimeOff}>Agregar ausencia</Button></div>
                {timeOff.map((item, index) => (
                  <div key={`${item.startsAt}-${index}`} className="col-span-full flex justify-between text-sm">
                    <span>{new Date(item.startsAt).toLocaleString("es-MX")} → {new Date(item.endsAt).toLocaleString("es-MX")} {item.reason ? `· ${item.reason}` : ""}</span>
                    <button type="button" onClick={() => setTimeOff((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Quitar</button>
                  </div>
                ))}
              </div>
              <Button onClick={saveAvailability}>Guardar horario</Button>
            </>
          )}
        </CardContent>
      </Card>
      {message && <p className="text-sm text-brand-text">{message}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

async function errorMessage(response: Response) {
  const data = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return data?.error?.message ?? "No se pudo guardar";
}
