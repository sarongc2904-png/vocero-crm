import { resolveScheduleScope } from "@/server/agenda/schedule-scope";

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

const EXPLICIT_SCHEDULING_WORDS =
  /\b(citas?|horarios?|agend(?:a|ar|arme|arnos|ado|ando|emos|en)?|reserv(?:a|ar|arme|arnos|ado|ando|emos|en)?|reprogram\w*|program(?:ar|arme|arnos|ado|ando|emos|en)|huecos?|cupos?)\b/;

const INFORMATIONAL_CATALOG_WORDS =
  /\b(servicios?|tratamientos?|productos?|paquetes?|programas?|planes?|precios?|costos?|menu)\b/;

/**
 * Señal determinista de que el turno actual realmente habla de agenda.
 *
 * La intención explícita de cita siempre gana. Si el mensaje habla de un
 * catálogo informativo (servicios, tratamientos, productos, precios, etc.) y
 * no contiene ninguna palabra inequívoca de agenda, no abrimos horarios aunque
 * también diga "disponible" o mencione una fecha. Esto protege frases como
 * "¿qué servicios tienen disponibles mañana?" y transcripciones equivalentes.
 */
export function hasSchedulingSignal(input: {
  text: string;
  now: Date;
  timezone: string;
}): boolean {
  const text = input.text.trim();
  if (!text) return false;

  const normalized = normalize(text);
  if (EXPLICIT_SCHEDULING_WORDS.test(normalized)) return true;
  if (INFORMATIONAL_CATALOG_WORDS.test(normalized)) return false;

  return Boolean(resolveScheduleScope(text, input.now, input.timezone));
}
