/**
 * Enlace público "Agregar a mi calendario" (Google Calendar): el CLIENTE lo
 * abre para guardar SU recordatorio de la cita, sin que su calendario tenga
 * nada que ver con el del negocio ni requiera credenciales de nadie — es una
 * URL de plantilla que Google resuelve del lado del navegador.
 *
 * Distinto del `meetingLink` de una videollamada: uno es para unirse a la
 * reunión, este es para no olvidar que existe. Se ofrecen los dos cuando
 * aplican.
 */
export function googleAddEventUrl(input: {
  title: string;
  startUtc: string;
  durationMinutes: number;
  details?: string;
  location?: string;
}): string {
  const start = new Date(input.startUtc);
  const end = new Date(start.getTime() + input.durationMinutes * 60_000);
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: input.title,
    dates: `${fmt(start)}/${fmt(end)}`,
  });
  if (input.details) params.set("details", input.details);
  if (input.location) params.set("location", input.location);

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
