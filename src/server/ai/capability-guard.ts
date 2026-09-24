/**
 * Guardia determinística de capacidades para texto generado por el modelo.
 *
 * El prompt orienta al LLM, pero esta capa es la última frontera antes de
 * enviar texto al cliente. Si una capacidad no existe en la instancia, una
 * respuesta libre del modelo no puede prometer que sí existe.
 */

const AGENDA_PROMISE_PATTERNS = [
  /\bagend(?:ar|amos|arte|arle|o|e|emos)\b.{0,40}\b(?:cita|horario|reuni[oó]n)\b/i,
  /\b(?:cita|horario|reuni[oó]n)\b.{0,40}\bagend(?:ar|amos|arte|arle|o|e|emos)\b/i,
  /\b(?:reservar|reservamos|reservarte|reservarle|programar|programamos|coordinar|coordinamos|apartar|apartamos)\b.{0,40}\b(?:cita|horario|reuni[oó]n)\b/i,
  /\b(?:te|le)\s+(?:agendo|agendamos|reservo|reservamos|programo|programamos|coordino|coordinamos)\b/i,
  /\b(?:mostrar|mostrarte|mostrarle|mostrarles|mostramos|muestro|ofrecer|ofrecerte|ofrecerle|ofrecerles|ofrecemos|ofrezco)\b.{0,30}\bhorarios?\s+disponibles\b/i,
];

export const AGENDA_DISABLED_SAFE_REPLY =
  "En este momento no puedo agendar citas ni reservar horarios desde este chat. Puedo ayudarte con la información que sí está confirmada en el conocimiento del negocio.";

export function promisesAgenda(text: string): boolean {
  return AGENDA_PROMISE_PATTERNS.some((pattern) => pattern.test(text));
}

export function enforceAgentCapabilities(input: {
  text: string;
  agenda: boolean;
}): string {
  if (input.agenda || !promisesAgenda(input.text)) return input.text;
  return AGENDA_DISABLED_SAFE_REPLY;
}
