/**
 * Intenciones de AMPLIACIÓN de disponibilidad en una conversación de agenda.
 *
 * Son follow-ups compactos ("otro día", "más tarde", "por la tarde", "fin de
 * semana") que el pipeline resuelve de forma determinista, NUNCA el LLM. No
 * compiten con `resolveScheduleScope` (fecha única / rango / general /
 * próxima cita): esas peticiones ya tienen su propio camino; esto cubre solo
 * las ampliaciones que NO mencionan una fecha concreta.
 *
 * Las expresiones se comparan sobre el texto NORMALIZADO (sin tildes): el
 * mismo criterio que `target-date.ts` y `schedule-scope.ts`, donde "mañana"
 * se normaliza a "manana".
 */

/**
 * `later` ("más tarde") pide horarios POSTERIORES a los ya mostrados ese día;
 * `afternoon` / `morning` ("por la tarde" / "por la mañana") piden ese bloque
 * del día que se está mostrando. Pasar de día es solo `next_day`.
 */
export type ExpandWindow = "afternoon" | "morning" | "weekend" | "next_day" | "later";

/**
 * "4 de la tarde", "las 10 de la mañana", "4:30 de la tarde": un número antes
 * del bloque es una HORA concreta, nunca una ampliación.
 */
const HOUR_BEFORE_DAYPART =
  /\b\d{1,2}(?::[0-5]\d)?(?:\s+y\s+(?:media|cuarto))?\s+(?:de|en|por)\s+la\s+(?:tarde|manana|noche)\b/;

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export function resolveExpandRequest(text: string): ExpandWindow | null {
  const norm = normalize(text);
  if (HOUR_BEFORE_DAYPART.test(norm)) return null;

  // "fin de semana" / "finde" — pide explícitamente sábado/domingo.
  if (/\bfin\s+de\s+semana\b|\bfinde\b/.test(norm)) return "weekend";

  // Daypart mañana: "por/en/de la mañana". El "mañana" a secas (=día de
  // mañana) NO entra aquí: lo resuelve `resolveTargetDate` como fecha única.
  if (/\b(?:por|en|de)\s+la\s+manana\b/.test(norm)) return "morning";

  // "Más tarde": horarios posteriores a los ya mostrados el mismo día.
  if (/\bmas\s+tarde\b/.test(norm)) return "later";

  // Tarde: "por/en/de la tarde".
  if (/\b(?:por|en|de)\s+la\s+tarde\b/.test(norm)) return "afternoon";

  // Más opciones / otro día / otros horarios.
  if (
    /\b(?:otro\s+dia|otros\s+horarios|otro\s+horario|otra\s+hora|otros\s+dias|mas\s+opciones|mas\s+horarios|ver\s+mas)\b/.test(
      norm
    )
  ) {
    return "next_day";
  }

  return null;
}
