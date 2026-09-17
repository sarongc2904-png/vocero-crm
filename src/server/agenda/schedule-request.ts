import { resolveScheduleScope } from "@/server/agenda/schedule-scope";

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

const EXPLICIT_SCHEDULING_WORDS =
  /\b(citas?|agend(?:a|ar|arme|arnos|ado|ando|emos|en)?|reserv(?:a|ar|arme|arnos|ado|ando|emos|en)?|disponib\w*|reprogram\w*|program\w*|espacios?|huecos?|cupos?)\b/;

/**
 * Señal determinista de que el turno actual realmente habla de agenda.
 *
 * No depende de la acción elegida por el LLM. Primero reutiliza el parser
 * temporal (día/rango/próxima/disponibilidad general) y después acepta verbos
 * explícitos de reserva. Así una pregunta informativa como "¿qué servicios
 * ofrecen?" no puede abrir la agenda, pero "quiero agendar ese servicio" sí.
 * También funciona con transcripciones sin signos de puntuación.
 */
export function hasSchedulingSignal(input: {
  text: string;
  now: Date;
  timezone: string;
}): boolean {
  const text = input.text.trim();
  if (!text) return false;
  if (resolveScheduleScope(text, input.now, input.timezone)) return true;
  return EXPLICIT_SCHEDULING_WORDS.test(normalize(text));
}
