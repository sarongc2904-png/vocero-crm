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
