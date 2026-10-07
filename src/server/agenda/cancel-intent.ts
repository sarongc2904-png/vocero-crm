/**
 * IA-1 — Cancelación SEGURA.
 *
 * Antes este detector corría antes del LLM y `handleCancellation` cancelaba la
 * cita de inmediato: "¿Puedo cancelar mi cita?" o "¿Cuánto cobran si cancelo mi
 * cita?" **cancelaban una cita real**. Una pregunta informativa no es una orden.
 *
 * Ahora el detector separa dos cosas:
 *  - {@link isCancellationQuestion}: pregunta/hipótesis → informativa, NO muta.
 *  - {@link matchesCancellationIntent}: orden imperativa → el pipeline abre una
 *    confirmación pendiente (tabla `pending_agenda_action`) y pide un "sí"
 *    explícito antes de tocar nada.
 */

const CANCEL_VERB =
  /\b(?:cancel(?:a|ar|en|emos|ala|alo|arla|arlo)|anul(?:a|ar|en|emos|ala|alo|arla|arlo))\b/;
const CANCEL_PRONOUN = /\b(?:cancelala|anulala|cancelalo|anulalo)\b/;
const APPOINTMENT_REF = /\b(?:cita|citas|reservaci[oó]n|reserva|turno)\b/;
/**
 * "cancela la del domingo", "cancela la de las 10", "anula la próxima": sin la
 * palabra "cita", el artículo seguido de "del/de/que/próxima" señala una cita.
 * "cancela el pedido" o "cancela el seguimiento" no.
 */
const CANCEL_REFERENCE =
  /\b(?:cancel|anul)(?:a|en|emos)\s+(?:la|el|esa|ese)\s+(?:del|de|que|proxim[ao]|siguiente)\b/;
/** "quiero cancelar" sin referencia explícita sigue siendo una orden. */
const CANCEL_REQUEST =
  /\b(?:quiero|deseo|necesito|quisiera|podrias|puedes)\s+(?:cancelar|anular)\b/;

/**
 * Marcas de pregunta o hipótesis. Si aparecen, el mensaje INFORMA y no ordena,
 * aunque use el verbo cancelar.
 */
const INFORMATIONAL_MARKERS =
  /[?¿]|\b(?:puedo|podria|podrias|se puede|es posible|hay forma|hay manera|que pasa si|qué pasa si|cuanto|cuánto|cuanto cobran|cobran|cuesta|penalizacion|penalización|politica|política|si me surge|si no puedo|si cancelo|si la cancelo|si lo cancelo|habria|habría|tendria|tendría)\b/;

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** ¿Es una ORDEN de cancelar (imperativa)? Las preguntas devuelven `false`. */
export function matchesCancellationIntent(text: string): boolean {
  const norm = normalize(text);
  if (INFORMATIONAL_MARKERS.test(norm)) return false;
  if (CANCEL_PRONOUN.test(norm)) return true;
  if (!CANCEL_VERB.test(norm)) return false;
  return (
    APPOINTMENT_REF.test(norm) ||
    CANCEL_REFERENCE.test(norm) ||
    CANCEL_REQUEST.test(norm) ||
    /^cancelar\b/.test(norm.trim())
  );
}

/** ¿Pregunta por cancelar sin pedirlo? (informativa: solo se responde). */
export function isCancellationQuestion(text: string): boolean {
  const norm = normalize(text);
  if (!CANCEL_VERB.test(norm) && !CANCEL_PRONOUN.test(norm)) return false;
  return INFORMATIONAL_MARKERS.test(norm);
}
