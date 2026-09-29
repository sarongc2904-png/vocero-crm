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

export type ExpandWindow = "afternoon" | "morning" | "weekend" | "next_day";

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export function resolveExpandRequest(text: string): ExpandWindow | null {
  const norm = normalize(text);

  // "fin de semana" / "finde" — pide explícitamente sábado/domingo.
  if (/\bfin\s+de\s+semana\b|\bfinde\b/.test(norm)) return "weekend";

  // Daypart mañana: "por/en/de la mañana". El "mañana" a secas (=día de
  // mañana) NO entra aquí: lo resuelve `resolveTargetDate` como fecha única.
  if (/\b(?:por|en|de)\s+la\s+manana\b/.test(norm)) return "morning";

  // Tarde: "por/en/de la tarde" o "más tarde".
  if (/\b(?:por|en|de)\s+la\s+tarde\b|\bmas\s+tarde\b/.test(norm)) {
    return "afternoon";
  }

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
