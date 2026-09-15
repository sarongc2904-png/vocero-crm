import { addDaysISO, todayInTz, weekdayKeyOf, type WeekdayKey } from "@/lib/time/slots";
import { resolveTargetDate } from "@/lib/time/target-date";

/**
 * Fase 1 — bug de rangos ("de lunes a domingo" devolvía solo lunes).
 *
 * Causa raíz: `resolveTargetDate` (y por lo tanto `resolveScheduleIntent`)
 * solo entienden UNA fecha. Para "de lunes a domingo" encontraban "lunes" —
 * la primera palabra de día que aparece en el texto — y ahí se detenían: el
 * rango se colapsaba a una sola fecha ANTES de que existiera ningún concepto
 * de "rango" en el sistema. No es un bug de `slice()`, es un bug de
 * clasificación: el "de X a Y" nunca se reconocía como una forma distinta.
 *
 * `resolveScheduleScope` es el clasificador que faltaba, y corre ANTES que
 * `resolveTargetDate` — que sigue existiendo tal cual, sin tocarse, y solo se
 * usa como último recurso para el caso que sí sabe resolver bien: una fecha
 * única. Los patrones de rango/general/próxima-cita se detectan aquí,
 * explícitamente, para que nunca lleguen a colapsarse en el parser de fecha
 * única.
 */

export type ScheduleScope =
  | { type: "single_date"; date: string }
  | { type: "date_range"; startDate: string; endDate: string }
  | { type: "next_available" }
  | { type: "general_availability" };

const WEEKDAY_NAMES: Record<string, WeekdayKey> = {
  lunes: "mon",
  martes: "tue",
  miercoles: "wed",
  jueves: "thu",
  viernes: "fri",
  sabado: "sat",
  domingo: "sun",
};

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Próxima fecha (>= hoy) cuyo día de semana sea `target`. Igual que en `target-date.ts`. */
function nextWeekday(target: WeekdayKey, todayISO: string, tz: string): string {
  for (let i = 0; i < 8; i++) {
    const candidate = addDaysISO(todayISO, i);
    if (weekdayKeyOf(candidate, tz) === target) return candidate;
  }
  return todayISO;
}

/** "próxima cita disponible", "el primer horario que tengan", "lo más pronto posible". */
const NEXT_AVAILABLE_WORDS =
  /\b(proxima cita|proximo horario|primer horario|primera cita|mas pronto|cuanto antes|lo antes posible)\b/;

/** "esta semana", "toda la semana" — rango implícito hoy..domingo. */
const WEEK_WORDS = /\b(esta semana|toda la semana)\b/;

/**
 * "dame todos los horarios", "qué tienes disponible", "toda la disponibilidad"
 * — pide ver huecos sin acotar a un día. Se revisa DESPUÉS de intentar una
 * fecha única para no robarle el caso a preguntas que sí mencionan un día
 * concreto (p. ej. "qué horarios tienes el sábado" es `single_date`, no esto).
 */
const GENERAL_WORDS =
  /\b(todos los horarios|toda la disponibilidad|disponibilidad general|que tienes disponible|que horarios tienes)\b/;

/**
 * Resuelve el ALCANCE temporal de la petición del cliente — no solo si
 * mencionó un día, sino QUÉ TIPO de petición es. `null` si no hay ninguna
 * señal de agenda en el texto (mismo contrato que antes: el llamador decide
 * qué hacer, incluyendo dejar que el `day` del modelo sea el único respaldo).
 */
export function resolveScheduleScope(
  text: string,
  now: Date,
  tz: string
): ScheduleScope | null {
  const norm = normalize(text);
  const todayISO = todayInTz(now, tz);

  // 1) Rango explícito "de <día> a <día>" — se revisa PRIMERO, antes de que
  // el parser de fecha única pueda robarse el primer nombre de día que vea.
  const dayNamesPattern = Object.keys(WEEKDAY_NAMES).join("|");
  const rangeMatch = new RegExp(
    `\\bde\\s+(${dayNamesPattern})\\s+a\\s+(${dayNamesPattern})\\b`
  ).exec(norm);
  if (rangeMatch) {
    const startKey = WEEKDAY_NAMES[rangeMatch[1]!]!;
    const endKey = WEEKDAY_NAMES[rangeMatch[2]!]!;
    const startDate = nextWeekday(startKey, todayISO, tz);
    let endDate = nextWeekday(endKey, todayISO, tz);
    // "de sábado a martes" cruza a la semana siguiente: el fin no puede
    // quedar ANTES que el inicio.
    if (endDate < startDate) endDate = addDaysISO(endDate, 7);
    return { type: "date_range", startDate, endDate };
  }

  // 2) "esta semana" / "toda la semana": hoy hasta el domingo que sigue.
  if (WEEK_WORDS.test(norm)) {
    return { type: "date_range", startDate: todayISO, endDate: nextWeekday("sun", todayISO, tz) };
  }

  // 3) "la próxima cita disponible" — sin fecha, quiere EL primer hueco.
  if (NEXT_AVAILABLE_WORDS.test(norm)) {
    return { type: "next_available" };
  }

  // 4) Fecha única reconocida por el parser existente — sin tocarlo.
  const single = resolveTargetDate(text, now, tz);
  if (single) return { type: "single_date", date: single.iso };

  // 5) Disponibilidad general, sin ningún día ni rango mencionado.
  if (GENERAL_WORDS.test(norm)) {
    return { type: "general_availability" };
  }

  return null;
}
