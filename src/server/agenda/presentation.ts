import { capitalize } from "@/server/agenda/schedule-intent";
import type { SpreadSlot } from "@/server/agenda/spread";
import { dayLabelInTz } from "@/lib/time/slots";

/**
 * Presentación de UN día de disponibilidad en el chat.
 *
 * Mañana = antes de las 12:00; tarde = desde las 12:00 hasta el cierre.
 *  - Sin preferencia: ambos bloques en el mismo mensaje. Con 6 huecos o menos
 *    en el día se listan todos; con más, hasta 3 por bloque REPARTIDOS a lo
 *    largo del bloque (primero, intermedios y último), no los primeros.
 *  - Con preferencia de bloque: solo ese bloque, repartido.
 *
 * Las horas van una por línea ("• 16:00") bajo el día y bajo "Mañana:" /
 * "Tarde:", el formato que `offersShownInLastMessage` sabe reconstruir.
 */

export type Daypart = "morning" | "afternoon";

const NOON_MINUTES = 12 * 60;
/** Hasta este total del día se lista todo; por encima se reparte. */
export const LIST_ALL_MAX = 6;
/** Horarios por bloque cuando se presentan ambos bloques. */
export const PER_DAYPART = 3;
/** Horarios de un solo bloque (preferencia explícita o "más tarde"). */
export const SINGLE_BLOCK = 4;

export const OTHER_TIME_INVITE =
  "Si otra hora funciona mejor, con gusto reviso si está libre.";

export function timeMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function daypartOf(time: string): Daypart {
  return timeMinutes(time) < NOON_MINUTES ? "morning" : "afternoon";
}

/**
 * `n` elementos repartidos a lo largo de `items` (incluye el primero y el
 * último). Con `items.length <= n` devuelve todos.
 */
export function spreadPick<T>(items: T[], n: number): T[] {
  if (n <= 0) return [];
  if (items.length <= n) return [...items];
  if (n === 1) return [items[0]!];
  const picked = new Set<number>();
  for (let i = 0; i < n; i += 1) {
    picked.add(Math.round((i * (items.length - 1)) / (n - 1)));
  }
  return [...picked].sort((a, b) => a - b).map((index) => items[index]!);
}

export type DayPresentation = {
  morning: SpreadSlot[];
  afternoon: SpreadSlot[];
  /** true si quedó algún hueco del día sin mostrar. */
  truncated: boolean;
};

/** Ambos bloques del día (regla sin preferencia). */
export function presentFullDay(daySlots: SpreadSlot[]): DayPresentation {
  const morning = daySlots.filter((slot) => daypartOf(slot.time) === "morning");
  const afternoon = daySlots.filter((slot) => daypartOf(slot.time) === "afternoon");
  if (daySlots.length <= LIST_ALL_MAX) {
    return { morning, afternoon, truncated: false };
  }
  const shownMorning = spreadPick(morning, PER_DAYPART);
  const shownAfternoon = spreadPick(afternoon, PER_DAYPART);
  return {
    morning: shownMorning,
    afternoon: shownAfternoon,
    truncated: shownMorning.length + shownAfternoon.length < daySlots.length,
  };
}

/** Un solo bloque (o una cola de horarios, para "más tarde"), repartido. */
export function presentBlock(slots: SpreadSlot[]): DayPresentation {
  const shown =
    slots.length <= LIST_ALL_MAX ? [...slots] : spreadPick(slots, SINGLE_BLOCK);
  return {
    morning: shown.filter((slot) => daypartOf(slot.time) === "morning"),
    afternoon: shown.filter((slot) => daypartOf(slot.time) === "afternoon"),
    truncated: shown.length < slots.length,
  };
}

export function presentationSlots(presentation: DayPresentation): SpreadSlot[] {
  return [...presentation.morning, ...presentation.afternoon];
}

/** Bloque de texto del día: título, "Mañana:" / "Tarde:" y una hora por línea. */
export function formatDayPresentation(
  presentation: DayPresentation,
  timezone: string,
  now: Date
): string {
  const first = presentation.morning[0] ?? presentation.afternoon[0];
  if (!first) return "";
  const lines = [capitalize(dayLabelInTz(first.startUtc, timezone, now))];
  if (presentation.morning.length > 0) {
    lines.push("Mañana:", ...presentation.morning.map((slot) => `• ${slot.time}`));
  }
  if (presentation.afternoon.length > 0) {
    lines.push("Tarde:", ...presentation.afternoon.map((slot) => `• ${slot.time}`));
  }
  return lines.join("\n");
}

/** Cierre de la oferta: elegir y, si no se listó todo, invitar a otra hora. */
export function offerClosing(presentation: DayPresentation): string {
  return presentation.truncated
    ? `¿Cuál te funciona mejor? ${OTHER_TIME_INVITE}`
    : "¿Cuál te funciona mejor?";
}
