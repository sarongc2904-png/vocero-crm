import { dayIsoInTz, weekdayKeyOf, zonedWallClockToUtc } from "@/lib/time/slots";
import type { WeeklyHours } from "@/server/agenda/settings";

/**
 * Resuelve una hora pedida por el cliente contra TODA la disponibilidad de
 * los días que se le están mostrando, no solo contra los horarios visibles.
 *
 * Puro: recibe los huecos libres por día y el horario semanal; no consulta BD
 * ni reloj. La decisión entre 04:00 y 16:00 ("a las 4") la toma la
 * disponibilidad y, si ninguna está libre, el horario de atención.
 */

export type TimeResolution =
  | { kind: "free"; startUtc: string }
  | { kind: "multiple"; startUtcs: string[] }
  | {
      kind: "taken" | "outside_hours";
      day: string;
      /** Minuto del día que se toma como referencia para el mensaje. */
      minute: number;
      /** Hasta 3 huecos libres del mismo día, los más cercanos, en orden. */
      nearest: string[];
    };

const NEAREST = 3;

export function hhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function minuteOf(startUtc: string, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(startUtc));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function intervalsOf(day: string, weeklyHours: WeeklyHours, timezone: string) {
  const weekday = weekdayKeyOf(day, timezone);
  return (weekday ? weeklyHours[weekday] ?? [] : []).map((interval) => ({
    start: Number(interval.start.slice(0, 2)) * 60 + Number(interval.start.slice(3, 5)),
    end: Number(interval.end.slice(0, 2)) * 60 + Number(interval.end.slice(3, 5)),
  }));
}

/** Distancia (en minutos) de `minute` al horario de atención del día. */
function distanceToHours(minute: number, intervals: { start: number; end: number }[]) {
  if (intervals.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(
    ...intervals.map((i) =>
      minute < i.start ? i.start - minute : minute >= i.end ? minute - i.end + 1 : 0
    )
  );
}

/** Agrupa inicios UTC libres por día (solo los días pedidos), sin duplicados. */
export function freeStartsByDay(
  starts: string[],
  days: string[],
  timezone: string
): Map<string, string[]> {
  const byDay = new Map<string, string[]>();
  for (const raw of starts) {
    const startUtc = new Date(raw).toISOString();
    const day = dayIsoInTz(new Date(startUtc), timezone);
    if (!days.includes(day)) continue;
    const list = byDay.get(day) ?? [];
    if (!list.includes(startUtc)) list.push(startUtc);
    byDay.set(day, list);
  }
  return byDay;
}

export function isWithinBusinessHours(
  day: string,
  minute: number,
  weeklyHours: WeeklyHours,
  timezone: string
): boolean {
  return distanceToHours(minute, intervalsOf(day, weeklyHours, timezone)) === 0;
}

export function businessHoursLabel(
  day: string,
  weeklyHours: WeeklyHours,
  timezone: string
): string {
  return intervalsOf(day, weeklyHours, timezone)
    .map((i) => `${hhmm(i.start)} a ${hhmm(i.end)}`)
    .join(" y ");
}

export function resolveRequestedTime(input: {
  candidates: number[];
  /** Días mostrados al cliente, en orden (el primero manda en los avisos). */
  days: string[];
  /** Huecos libres (inicio UTC) por día. */
  freeByDay: Map<string, string[]>;
  weeklyHours: WeeklyHours;
  timezone: string;
}): TimeResolution | null {
  const { candidates, days, freeByDay, weeklyHours, timezone } = input;
  if (candidates.length === 0 || days.length === 0) return null;

  const hits = new Set<string>();
  for (const day of days) {
    const free = new Set(freeByDay.get(day) ?? []);
    for (const minute of candidates) {
      const start = zonedWallClockToUtc(day, hhmm(minute), timezone)?.toISOString();
      if (start && free.has(start)) hits.add(start);
    }
  }
  const unique = [...hits].sort();
  if (unique.length === 1) return { kind: "free", startUtc: unique[0]! };
  if (unique.length > 1) return { kind: "multiple", startUtcs: unique };

  const day = days[0]!;
  const intervals = intervalsOf(day, weeklyHours, timezone);
  const inHours = candidates.filter((m) => distanceToHours(m, intervals) === 0);
  const kind = inHours.length > 0 ? "taken" : "outside_hours";
  // Referencia: la lectura dentro de horario; si ninguna lo está, la más
  // cercana al horario de atención (las 8 → 20:00 si cierra a las 18:00).
  const minute =
    inHours[0] ??
    [...candidates].sort(
      (a, b) => distanceToHours(a, intervals) - distanceToHours(b, intervals)
    )[0]!;

  const nearest = [...(freeByDay.get(day) ?? [])]
    .map((startUtc) => ({ startUtc, minute: minuteOf(startUtc, timezone) }))
    .sort(
      (a, b) =>
        Math.abs(a.minute - minute) - Math.abs(b.minute - minute) ||
        a.minute - b.minute
    )
    .slice(0, NEAREST)
    .sort((a, b) => a.minute - b.minute)
    .map((slot) => slot.startUtc);

  return { kind, day, minute, nearest };
}
