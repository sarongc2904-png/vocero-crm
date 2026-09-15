import { dateLabelInTz } from "@/lib/time/slots";
import { businessHoursFact } from "@/lib/time/target-date";
import { resolveScheduleScope } from "@/server/agenda/schedule-scope";
import type { WeeklyHours } from "@/server/agenda/settings";

/**
 * Fase 1 — corrección a la regresión de domingo.
 *
 * Causa raíz confirmada en producción: `resolveTargetDate`/`businessHoursFact`
 * ya calculaban la verdad correcta y se inyectaba al prompt como instrucción
 * — pero seguía siendo SOLO una instrucción. Cuando el turno del cliente no
 * disparaba `offer_slots`/`book_slot` (una pregunta conversacional simple:
 * "¿abren domingo?"), la respuesta salía como `{"action":"reply","text":...}`,
 * texto 100% libre, y el modelo ignoró la instrucción y afirmó "cerrado" con
 * el domingo configurado abierto.
 *
 * `resolveScheduleIntent` es el guardarraíl determinista que faltaba: si el
 * turno menciona una fecha, el backend decide la verdad factual (fecha,
 * abierto/cerrado, horario, y si hace falta consultar disponibilidad real) —
 * el LLM puede aportar intención y tono, pero el pipeline (`ai/pipeline.ts`)
 * usa este resultado para CONSTRUIR o REEMPLAZAR la respuesta cuando la
 * acción del modelo es `reply` u `offer_slots`, en vez de confiar en que el
 * modelo haya obedecido la instrucción del prompt. No es una búsqueda de
 * palabras como "cerrado"/"abierto" en lo que el modelo respondió — es una
 * decisión tomada ANTES de que el texto del modelo importe.
 */

/** Palabras que indican que el cliente quiere ver horarios/reservar, no solo saber si se trabaja. */
const AVAILABILITY_WORDS =
  /\b(cita|citas|agendar|agenda|reserv|espacio|espacios|hueco|huecos|disponib|cupo|cupos)\b/;

/** Palabras de la pregunta "¿se trabaja ese día?" sin pedir explícitamente horarios. */
const HOURS_ONLY_WORDS =
  /\b(abren|abierto|abiertos|abierta|cerrado|cerrados|cerrada|trabajan|atienden|horario|horarios)\b/;

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** "09:00-17:00" → "09:00 a 17:00" (varios intervalos separados por coma). */
export function formatHoursEs(businessHours: string): string {
  return businessHours.replace(/(\d{2}:\d{2})-(\d{2}:\d{2})/g, "$1 a $2");
}

/** "domingo, 20 de septiembre" → "Domingo, 20 de septiembre". */
export function capitalize(text: string): string {
  return text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text;
}

export type ScheduleIntent =
  | { kind: "none" }
  | {
      kind: "date_mentioned";
      /** YYYY-MM-DD, calculado por `resolveTargetDate` — nunca por el LLM. */
      targetDate: string;
      /** "domingo, 20 de septiembre" — misma fuente que usa el prompt y las respuestas. */
      dateLabel: string;
      businessOpen: boolean;
      /** "09:00-17:00" o "cerrado". */
      businessHours: string;
      timezone: string;
      /**
       * true ⇒ el cliente parece querer ver horarios/reservar (o no hay señal
       * clara — por defecto se prefiere mostrar disponibilidad real a
       * arriesgarse a un "sí/no" corto que no ayude). false ⇒ solo preguntó
       * si se trabaja ese día, sin pedir agendar todavía.
       */
      requiresAvailabilityLookup: boolean;
    };

export function resolveScheduleIntent(input: {
  text: string;
  now: Date;
  weeklyHours: WeeklyHours;
  timezone: string;
}): ScheduleIntent {
  /**
   * Bug de rangos — "de lunes a domingo" NO debe pasar por aquí: antes se
   * llamaba directo a `resolveTargetDate`, que encontraba "lunes" (la
   * primera palabra de día del texto) y colapsaba el rango a una fecha
   * única. Pasando por `resolveScheduleScope` primero, un rango se clasifica
   * como `date_range` y este módulo lo ignora (`kind: "none"`) — lo maneja
   * `pipeline.ts` con `offerRange`, nunca con una fecha única inventada.
   */
  const scope = resolveScheduleScope(input.text, input.now, input.timezone);
  if (!scope || scope.type !== "single_date") return { kind: "none" };

  const fact = businessHoursFact(scope.date, input.weeklyHours, input.timezone);
  const norm = normalize(input.text);
  const pideDisponibilidad = AVAILABILITY_WORDS.test(norm);
  const soloPreguntaHorario = !pideDisponibilidad && HOURS_ONLY_WORDS.test(norm);

  return {
    kind: "date_mentioned",
    targetDate: fact.targetDate,
    dateLabel: dateLabelInTz(fact.targetDate, input.timezone),
    businessOpen: fact.businessOpen,
    businessHours: fact.businessHours,
    timezone: fact.timezone,
    requiresAvailabilityLookup: !soloPreguntaHorario,
  };
}

/**
 * La respuesta corta cuando el cliente SOLO preguntó horario (Caso 2 del
 * reporte), sin pedir ver huecos — construida 100% por el backend, nunca por
 * el LLM.
 */
export function factualHoursReply(intent: Extract<ScheduleIntent, { kind: "date_mentioned" }>): string {
  return intent.businessOpen
    ? `Sí, ${intent.dateLabel} abrimos de ${formatHoursEs(intent.businessHours)}.`
    : `${capitalize(intent.dateLabel)} estamos cerrados.`;
}
