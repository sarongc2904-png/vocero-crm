import {
  dayIsoInTz,
  dayLabelInTz,
  dateLabelInTz,
  labelInTz,
  timeInTz,
} from "@/lib/time/slots";
import type { OfferedSlot } from "@/server/agenda/offers";

/**
 * Distinción determinista entre "mencionar/seleccionar un horario" y
 * "confirmar que quieres agendarlo".
 *
 * El cliente puede decir "10:20", "la primera" o "el de las 11" sin pedir
 * todavía que se cree la cita; solo una confirmación explícita ("sí",
 * "agéndalo", "quiero", "resérvame", "dale"...) habilita `book_slot`.
 *
 * El pipeline usa `isBareTimeSelection` como guardarraíl: un `book_slot` que
 * llega sobre una selección desnuda se convierte en una pregunta de
 * confirmación en lugar de reservar de inmediato.
 */

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Palabras que convierten una mención de hora en un pedido real de reserva. */
const BOOKING_CONFIRM =
  /\b(?:si|quiero|agendame|agendamelo|agendalo|agenda|agendar|reservame|reservamelo|reservalo|reserva|reservar|confirmo|confirmado|confirmar|dale|de acuerdo|perfecto|listo|ok|me sirve|adelante|va)\b/;

/** Selección de un horario concreto (hora, posición ordinal o "de las X"). */
const TIME_SELECTION =
  /\b\d{1,2}:\d{2}\b|\b(?:la|el)\s+(?:primera|primero|segunda|segundo|tercera|tercero|cuarta|cuarto|ultima|ultimo)\b|\b(?:la|el)\s+de\s+las\s+\d{1,2}\b|\b(?:la|el)\s+de\s+\d{1,2}\b|\ba\s+las\s+\d{1,2}(?::\d{2})?\b/;

export function isBareTimeSelection(text: string): boolean {
  const norm = normalize(text);
  if (!TIME_SELECTION.test(norm) && parseRequestedTime(text)?.kind !== "time") {
    return false;
  }
  return !BOOKING_CONFIRM.test(norm);
}

/**
 * Hora que el cliente pide con sus palabras, o un número suelto.
 *
 * `time.candidates` son minutos del día. Sin am/pm ni "de la tarde", una hora
 * de 1 a 11 tiene dos lecturas (4 → 04:00 y 16:00); quien resuelve decide con
 * el horario de atención y la disponibilidad, nunca por intuición.
 *
 * `bare_number` es un número solo ("4"): con una lista mostrada es ambiguo
 * (¿opción 4 u hora 4?) y se pregunta.
 */
export type RequestedTime =
  | { kind: "time"; candidates: number[] }
  | { kind: "bare_number"; value: number };

const TIME_EXPRESSION =
  /(?:^|\s)((?:a\s+)?las\s+|(?:el|la)\s+de\s+(?:las\s+)?)?(\d{1,2})(?::([0-5]\d))?(?:\s+y\s+(media|cuarto))?(?:\s*(am|pm)|\s+(?:de|en|por)\s+la\s+(manana|tarde|noche))?(?=\s|$)/g;

export function parseRequestedTime(text: string): RequestedTime | null {
  const norm = normalize(text)
    // "p. m." / "p.m." / "pm" → "pm" antes de quitar la puntuación.
    .replace(/\b([ap])\.?\s*m\b\.?/g, "$1m")
    .replace(/[¿?¡!.,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (/^\d{1,2}$/.test(norm)) {
    return { kind: "bare_number", value: Number(norm) };
  }

  for (const match of norm.matchAll(TIME_EXPRESSION)) {
    const [, prefix, hourRaw, minuteRaw, fraction, ampm, daypart] = match;
    // Sin dos puntos, fracción, am/pm, bloque ni "a las": no es una hora
    // ("el 7 de octubre", "martes 6").
    if (!prefix && !minuteRaw && !fraction && !ampm && !daypart) continue;

    let hour = Number(hourRaw);
    const minute = minuteRaw
      ? Number(minuteRaw)
      : fraction === "media"
        ? 30
        : fraction === "cuarto"
          ? 15
          : 0;
    if (hour > 23) continue;

    const pm = ampm === "pm" || daypart === "tarde" || daypart === "noche";
    const am = ampm === "am" || daypart === "manana";
    if (pm) {
      if (hour > 12) continue;
      if (hour < 12) hour += 12;
      return { kind: "time", candidates: [hour * 60 + minute] };
    }
    if (am) {
      if (hour > 12) continue;
      if (hour === 12) hour = 0;
      return { kind: "time", candidates: [hour * 60 + minute] };
    }
    // "07:00" (con cero a la izquierda) ya es reloj de 24 h: una sola lectura.
    const twentyFourHour = Boolean(minuteRaw) && hourRaw!.length === 2;
    if (hour >= 13 || hour === 0 || hour === 12 || twentyFourHour) {
      return { kind: "time", candidates: [hour * 60 + minute] };
    }
    return {
      kind: "time",
      candidates: [hour * 60 + minute, (hour + 12) * 60 + minute],
    };
  }
  return null;
}

/**
 * AG-HOLA — ¿El cliente está confirmando explícitamente una acción de agenda?
 *
 * Se usa junto a `isBareTimeSelection` para decidir si el turno ACTUAL toca
 * agenda. Un "sí, agéndala" es señal suficiente; un "Hola" no lo es, y sin esta
 * distinción el catálogo de huecos se le entregaba al modelo en turnos
 * neutrales — heredando la intención de una conversación anterior.
 */
export function hasBookingConfirmation(text: string): boolean {
  return BOOKING_CONFIRM.test(normalize(text));
}

export type OfferedTimeSelectionResolution =
  | { kind: "match"; offer: OfferedSlot; shownOffers: OfferedSlot[] }
  | { kind: "ambiguous"; offers: OfferedSlot[]; shownOffers: OfferedSlot[] }
  | { kind: "not_found"; shownOffers: OfferedSlot[] }
  | { kind: "not_time"; shownOffers: OfferedSlot[] };

function searchable(text: string): string {
  return normalize(text)
    .replace(/[^a-z0-9:\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type ParsedSelection =
  | { kind: "ordinal"; index: number | "last" }
  | { kind: "minute"; candidates: number[] }
  | { kind: "hour"; candidates: number[] };

function parseSelection(text: string): ParsedSelection | null {
  const normalized = normalize(text);
  const ordinal =
    /\b(?:la|el)\s+(primera|primero|segunda|segundo|tercera|tercero|cuarta|cuarto|ultima|ultimo)\b/.exec(
      normalized
    );
  if (ordinal) {
    const positions: Record<string, number | "last"> = {
      primera: 0,
      primero: 0,
      segunda: 1,
      segundo: 1,
      tercera: 2,
      tercero: 2,
      cuarta: 3,
      cuarto: 3,
      ultima: "last",
      ultimo: "last",
    };
    return { kind: "ordinal", index: positions[ordinal[1]!]! };
  }

  const match = /\b(\d{1,2}):([0-5]\d)\s*(a\.?\s*m\.?|p\.?\s*m\.?)?\b/i.exec(
    text
  );
  if (!match) {
    const hourOnly =
      /\b(?:(?:la|el)\s+de(?:\s+las)?|a\s+las)\s+(\d{1,2})\b/.exec(
        normalized
      );
    if (!hourOnly) return null;
    const hour = Number(hourOnly[1]);
    if (hour > 23) return null;
    if (hour >= 13 || hour === 0 || hour === 12) {
      return { kind: "hour", candidates: [hour] };
    }
    return { kind: "hour", candidates: [hour, hour + 12] };
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23) return null;

  const meridiem = match[3]?.toLowerCase().replace(/[^apm]/g, "");
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    const hour24 =
      meridiem === "pm" ? (hour === 12 ? 12 : hour + 12) : hour === 12 ? 0 : hour;
    return { kind: "minute", candidates: [hour24 * 60 + minute] };
  }

  if (hour >= 13 || hour === 0 || hour === 12) {
    return { kind: "minute", candidates: [hour * 60 + minute] };
  }

  // Sin am/pm, solo son candidatos los dos relojes posibles. La ventana que
  // el backend acaba de mostrar decide cuál existe; nunca se elige por intuición.
  return {
    kind: "minute",
    candidates: [hour * 60 + minute, (hour + 12) * 60 + minute],
  };
}

function minutesInTz(startUtc: string, timezone: string): number | null {
  const time = timeInTz(startUtc, timezone);
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Reconstruye la última ventana REALMENTE mostrada a partir del mensaje
 * saliente factual. `offered_slot` conserva a propósito el catálogo completo
 * para paginar; usarlo directamente haría ambiguo un mismo 14:20 repetido en
 * siete días aunque el cliente solo haya visto uno.
 */
export function offersShownInLastMessage(input: {
  offers: OfferedSlot[];
  lastOutboundText: string;
  timezone: string;
  shownAt: Date;
}): OfferedSlot[] {
  const { offers, lastOutboundText, timezone, shownAt } = input;
  if (!lastOutboundText.trim() || offers.length === 0) return [];

  const byDay = new Map<string, OfferedSlot[]>();
  for (const offer of offers) {
    const day = dayIsoInTz(new Date(offer.startUtc), timezone);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(offer);
    else byDay.set(day, [offer]);
  }

  const shown = new Map<string, OfferedSlot>();
  let activeDay: string | null = null;
  for (const rawLine of lastOutboundText.split(/\r?\n/)) {
    const line = searchable(rawLine);
    if (!line) continue;

    for (const [day, dayOffers] of byDay) {
      const longDay = searchable(
        dayLabelInTz(dayOffers[0]!.startUtc, timezone, shownAt)
      );
      const absoluteDay = searchable(dateLabelInTz(day, timezone));
      if (
        (longDay && line.includes(longDay)) ||
        (absoluteDay && line.includes(absoluteDay))
      ) {
        activeDay = day;
        break;
      }
    }

    // Algunas respuestas muestran la etiqueta completa en una sola línea
    // (próxima cita o re-oferta tras conflicto), sin bloque día + viñetas.
    for (const offer of offers) {
      const shortLabel = searchable(labelInTz(offer.startUtc, timezone));
      const longLabel = searchable(
        `${dayLabelInTz(offer.startUtc, timezone, shownAt)} a las ${timeInTz(
          offer.startUtc,
          timezone
        )}`
      );
      if (
        (shortLabel && line.includes(shortLabel)) ||
        (longLabel && line.includes(longLabel))
      ) {
        shown.set(offer.startUtc, offer);
      }
    }

    const bulletTime = /^[\s•▪◦*-]*(\d{1,2}):([0-5]\d)\s*$/.exec(rawLine.trim());
    if (!bulletTime || !activeDay) continue;
    const minute = Number(bulletTime[1]) * 60 + Number(bulletTime[2]);
    for (const offer of byDay.get(activeDay) ?? []) {
      if (minutesInTz(offer.startUtc, timezone) === minute) {
        shown.set(offer.startUtc, offer);
      }
    }
  }

  return [...shown.values()].sort(
    (a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc)
  );
}

/**
 * Convierte una selección humana ("2:20", "2:20 pm", "a las 2:20") al
 * instante exacto de la última ventana mostrada. No consulta al LLM y jamás
 * busca fuera de esa ventana.
 */
export function resolveOfferedTimeSelection(input: {
  text: string;
  offers: OfferedSlot[];
  lastOutboundText: string;
  timezone: string;
  shownAt: Date;
}): OfferedTimeSelectionResolution {
  const shownOffers = offersShownInLastMessage(input);
  const selection = parseSelection(input.text);
  if (!selection) return { kind: "not_time", shownOffers };

  if (selection.kind === "ordinal") {
    const index =
      selection.index === "last"
        ? shownOffers.length - 1
        : selection.index;
    const offer = shownOffers[index];
    return offer
      ? { kind: "match", offer, shownOffers }
      : { kind: "not_found", shownOffers };
  }

  const matches = shownOffers.filter((offer) => {
    const minute = minutesInTz(offer.startUtc, input.timezone);
    if (minute === null) return false;
    return selection.kind === "minute"
      ? selection.candidates.includes(minute)
      : selection.candidates.includes(Math.floor(minute / 60));
  });
  const unique = [...new Map(matches.map((offer) => [offer.startUtc, offer])).values()];

  if (unique.length === 1) {
    return { kind: "match", offer: unique[0]!, shownOffers };
  }
  if (unique.length > 1) {
    return { kind: "ambiguous", offers: unique, shownOffers };
  }
  return { kind: "not_found", shownOffers };
}

/** Texto factual breve para pedir confirmación sin dejar la hora al modelo. */
export function selectedOfferConfirmationLabel(
  startUtc: string,
  timezone: string
): string {
  const parts = new Intl.DateTimeFormat("es-MX", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
  }).formatToParts(new Date(startUtc));
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${weekday} ${day} a las ${timeInTz(startUtc, timezone)}`.trim();
}

/** Un "sí" al principio del mensaje, sin condicional detrás ("si me surge algo"). */
const AFFIRMATIVE =
  /^(?:si|sii+|sip|claro|correcto|exacto|asi es|confirmo|confirmado|confirmar|de acuerdo|ok|okay|vale|dale|va|adelante|hazlo|hazla|por favor|perfecto)\b/;

const CONDITIONAL_AFTER_SI =
  /\bsi\b\s+(?:me|te|le|nos|no|surge|pasa|puedo|tengo|acaso|es que|fuera|hubiera)\b/;

/**
 * IA-W2 — ¿Es una CONFIRMACIÓN inequívoca?
 *
 * Deliberadamente estricta: "sí", "sí, cancélala", "confirmo", "dale". Un "si"
 * condicional ("si me surge algo") NO confirma nada, y un mensaje largo con
 * "sí" dentro tampoco (podría ser una pregunta que empieza igual).
 */
export function isAffirmativeConfirmation(text: string): boolean {
  const norm = normalize(text).trim();
  if (!AFFIRMATIVE.test(norm)) return false;
  if (CONDITIONAL_AFTER_SI.test(norm)) return false;
  return norm.split(/\s+/).length <= 5;
}
