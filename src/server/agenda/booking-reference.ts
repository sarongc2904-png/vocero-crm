/**
 * ¿De qué cita habla el cliente?
 *
 * Con más de una cita activa, "cancela mi cita" no basta: cancelar o mover la
 * próxima por defecto puede tocar la que el cliente NO pidió. Este módulo solo
 * identifica la cita cuando el mensaje la distingue sin ambigüedad (día de la
 * semana, día del mes, mes u hora; o "la segunda" justo después de que el
 * agente listó las citas). Si no, devuelve null y el agente pregunta cuál.
 */

export type ActiveBookingRef = {
  id: string;
  startUtc: string;
  timezone: string;
  /** "viernes, 9 de octubre a las 10:00": así se le nombra al cliente. */
  label: string;
};

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

const WEEKDAYS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
  "septiembre", "octubre", "noviembre", "diciembre",
];
const ORDINALS: Record<string, number> = {
  primera: 1, primero: 1, segunda: 2, segundo: 2, tercera: 3, tercero: 3,
  cuarta: 4, cuarto: 4, quinta: 5, quinto: 5, ultima: -1, ultimo: -1,
};

type Parts = { weekday: string; day: number; month: string; hour: number; minute: number };

function partsInTz(startUtc: string, timezone: string): Parts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(startUtc));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return {
    weekday: WEEKDAYS[weekdayIndex] ?? "",
    day: Number(get("day")),
    month: MONTHS[Number(get("month")) - 1] ?? "",
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
  };
}

/** Horas mencionadas: "a las 6", "las 18:00", "6 de la tarde", "6pm". */
function mentionedHours(norm: string): number[] {
  const hours: number[] = [];
  const re =
    /\b(?:a\s+las|las|la)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|de la manana|de la tarde|de la noche)?|\b(\d{1,2}):(\d{2})\b|\b(\d{1,2})\s*(am|pm)\b/g;
  for (const match of norm.matchAll(re)) {
    const raw = Number(match[1] ?? match[4] ?? match[6]);
    if (!Number.isFinite(raw) || raw > 24) continue;
    const suffix = match[3] ?? match[7] ?? "";
    let hour = raw % 24;
    if (/pm|p\.m\.|tarde|noche/.test(suffix) && hour < 12) hour += 12;
    if (/am|a\.m\.|manana/.test(suffix) && hour === 12) hour = 0;
    hours.push(hour);
  }
  return hours;
}

/** Días del mes mencionados: "el 12", "del 9 de octubre", "día 12". */
function mentionedDays(norm: string): number[] {
  const days: number[] = [];
  const re = /\b(?:el|del|dia)\s+(\d{1,2})\b(?!\s*(?::|am|pm|de la (?:manana|tarde|noche)))/g;
  for (const match of norm.matchAll(re)) {
    const day = Number(match[1]);
    if (day >= 1 && day <= 31) days.push(day);
  }
  return days;
}

function ordinalChoice(norm: string, count: number): number | null {
  const words = norm.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  for (const word of words) {
    if (word in ORDINALS) {
      const n = ORDINALS[word]!;
      return n === -1 ? count : n;
    }
  }
  // "1", "la 2", "la opción 2", "número 2": solo números sueltos, nunca horas.
  const bare = norm.trim().match(/^(?:(?:la|el)\s+)?(?:(?:opcion|numero|cita)\s+)?(\d{1,2})[.)]?$/);
  return bare ? Number(bare[1]) : null;
}

/**
 * La cita a la que se refiere `text`, o null si no la distingue de las demás.
 * `listed`: el agente acaba de listar las citas numeradas, así que "la
 * segunda" o "2" eligen por posición.
 */
export function resolveBookingReference(
  text: string,
  bookings: ActiveBookingRef[],
  options: { listed?: boolean } = {}
): ActiveBookingRef | null {
  if (bookings.length === 0) return null;
  const norm = normalize(text);

  if (options.listed) {
    const choice = ordinalChoice(norm, bookings.length);
    if (choice !== null) return bookings[choice - 1] ?? null;
  }

  const words = new Set(norm.replace(/[^a-z0-9\s]/g, " ").split(/\s+/));
  const weekdays = WEEKDAYS.filter((day) => words.has(day));
  const months = MONTHS.filter((month) => words.has(month));
  const days = mentionedDays(norm);
  const hours = mentionedHours(norm);
  if (!weekdays.length && !months.length && !days.length && !hours.length) return null;

  const matches = bookings.filter((booking) => {
    const parts = partsInTz(booking.startUtc, booking.timezone);
    if (weekdays.length && !weekdays.includes(parts.weekday)) return false;
    if (months.length && !months.includes(parts.month)) return false;
    if (days.length && !days.includes(parts.day)) return false;
    // Una hora "a las 6" sin am/pm también acepta las 18:00.
    if (hours.length && !hours.some((h) => h === parts.hour || (h < 12 && h + 12 === parts.hour))) {
      return false;
    }
    return true;
  });
  return matches.length === 1 ? matches[0]! : null;
}

/** "¿Cuál de tus citas…?" con las citas numeradas. */
export function bookingChoiceList(bookings: ActiveBookingRef[]): string {
  return bookings.map((booking, i) => `${i + 1}. ${booking.label}`).join("\n");
}

const RESCHEDULE_ALWAYS = /\b(?:reprogram\w*|reagend\w*)\b/;
const RESCHEDULE_PRONOUN = /\b(?:cambiala|cambialo|muevela|muevelo|recorrela|recorrelo|pasala|pasalo)\b/;
const RESCHEDULE_VERB = /\b(?:cambi(?:ar|a|o|e|en|emos)|mover|muev(?:e|o|a|en)|recorr(?:er|e|o|a)|pasar)\b/;
const APPOINTMENT_REF = /\b(?:cita|citas|reservacion|reserva|turno|hora|horario)\b/;

/** ¿El cliente quiere mover una cita que ya tiene? (no crear otra). */
export function matchesRescheduleIntent(text: string): boolean {
  const norm = normalize(text);
  if (RESCHEDULE_ALWAYS.test(norm) || RESCHEDULE_PRONOUN.test(norm)) return true;
  return RESCHEDULE_VERB.test(norm) && APPOINTMENT_REF.test(norm);
}
