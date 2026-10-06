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
  if (!TIME_SELECTION.test(norm)) return false;
  return !BOOKING_CONFIRM.test(norm);
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

/**
 * Resultado de leer la respuesta del cliente a una acción de agenda pendiente.
 *
 * - `confirm`: confirmación explícita y sin condiciones ("sí", "dale",
 *   "de acuerdo", "sí, gracias", "👍"). Solo esto ejecuta la acción.
 * - `unclear`: empieza afirmando pero trae algo más que no es una condición de
 *   hora/día ("sí, ¿y cuánto cuesta?", "ok, pero rápido", "va a llover?").
 *   Ante la duda NO se confirma: se repite la pregunta una vez.
 * - `other`: negativa ("claro que no", "ok no"), condicional ("si me
 *   pudieras…"), otra hora/día ("sí pero a las 5", "vale, pero mejor el
 *   jueves") o un tema distinto. La acción pendiente se descarta.
 */
export type ConfirmationVerdict = "confirm" | "unclear" | "other";

/**
 * 👍 (con o sin tono de piel) cuenta como "ok": en WhatsApp es la forma más
 * común de aceptar una propuesta. Cualquier otro emoji no confirma.
 */
const THUMBS_UP = /\u{1F44D}[\u{1F3FB}-\u{1F3FF}]?/gu;

/** Frases de varias palabras que se leen como una sola. */
const CONFIRM_PHRASES: [RegExp, string][] = [
  [/\bclaro que si\b/g, "claro"],
  [/\bde acuerdo\b/g, "deacuerdo"],
  [/\besta bien\b/g, "estabien"],
  [/\bpor favor\b/g, "porfavor"],
  [/\basi es\b/g, "asies"],
  [/\bmuchas gracias\b/g, "gracias"],
];

/** Palabras con las que puede empezar una confirmación. */
const CONFIRM_OPENERS = new Set([
  "si", "sip", "claro", "ok", "okay", "oki", "va", "vale", "dale", "perfecto",
  "confirmo", "confirmado", "correcto", "exacto", "adelante", "deacuerdo",
  "estabien", "porfavor", "asies", "hazlo", "hazla",
]);

/** Lo que puede acompañar a la confirmación sin cambiarla. */
const CONFIRM_COMPANIONS = new Set([
  ...CONFIRM_OPENERS,
  "gracias", "porfa", "listo", "genial", "excelente", "quiero",
  "agendala", "agendalo", "agendame", "agendamela", "agendamelo",
  "reservala", "reservalo", "reservame", "reservamela", "reservamelo",
  "cancelala", "cancelalo", "muevela", "muevelo", "cambiala", "cambialo",
]);

const NEGATIONS = new Set(["no", "ni", "nunca", "tampoco", "jamas", "nel", "nop", "nope"]);

/** "si" condicional: "si me surge algo", "si me pudieras decir…". */
const CONDITIONAL_AFTER_SI = new Set([
  "me", "te", "le", "nos", "les", "surge", "pasa", "puedo", "puedes", "pudieras",
  "pudiera", "tengo", "acaso", "es", "fuera", "hubiera", "quieres", "gustas",
]);

/** Una hora o un día distinto del propuesto convierte el "sí" en otra petición. */
const TIME_OR_DAY = new Set([
  "manana", "tarde", "noche", "hoy", "pasado", "temprano", "mediodia",
  "lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo",
  "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
  "septiembre", "setiembre", "octubre", "noviembre", "diciembre",
  "semana", "dia", "hora", "horas", "las",
]);

/** Matices que piden algo más: ante ellos no se confirma. */
const DOUBT_WORDS = new Set(["pero", "mejor", "aunque", "antes", "primero", "espera", "pregunta"]);

const MAX_CONFIRMATION_WORDS = 6;

/**
 * IA-W2 — Clasifica la respuesta a una acción pendiente. Ante la duda NO
 * confirma: lo que no sea una confirmación limpia es `unclear` u `other`.
 */
export function classifyConfirmation(text: string): ConfirmationVerdict {
  let norm = normalize(text).replace(THUMBS_UP, " ok ");
  const asks = /[?¿]/.test(norm);
  const hasDigits = /\d/.test(norm);
  norm = norm
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [phrase, token] of CONFIRM_PHRASES) norm = norm.replace(phrase, token);

  const words = norm ? norm.split(" ") : [];
  const first = words[0];
  const opens = first !== undefined && (CONFIRM_OPENERS.has(first) || /^si+p?$/.test(first));
  if (!opens) return "other";
  if (words.some((word) => NEGATIONS.has(word))) return "other";
  if (first.startsWith("si") && words[1] && CONDITIONAL_AFTER_SI.has(words[1])) return "other";
  if (hasDigits || words.some((word) => TIME_OR_DAY.has(word))) return "other";
  if (asks || words.some((word) => DOUBT_WORDS.has(word))) return "unclear";
  if (words.length > MAX_CONFIRMATION_WORDS) return "unclear";
  const rest = words.slice(1);
  return rest.every((word) => CONFIRM_COMPANIONS.has(word) || /^si+p?$/.test(word))
    ? "confirm"
    : "unclear";
}

/**
 * IA-W2 — ¿Es una CONFIRMACIÓN inequívoca? Solo `confirm` cuenta: negaciones,
 * preguntas, "pero"/"mejor", horas o días distintos y condicionales no.
 */
export function isAffirmativeConfirmation(text: string): boolean {
  return classifyConfirmation(text) === "confirm";
}
