import { addDaysISO, todayInTz, weekdayKeyOf, type WeekdayKey } from "@/lib/time/slots";

/**
 * Fase 1 — resolución DETERMINISTA de "qué día pidió el cliente", server-side.
 *
 * Causa raíz del bug de agenda (ver reporte): el LLM calculaba `offer_slots.day`
 * desde lenguaje natural y fallaba con frecuencia — y cuando fallaba, el sistema
 * igual mostraba el texto libre del modelo (que podía seguir diciendo "sábado")
 * junto al catálogo general de otros días. Esto reemplaza ese cálculo por un
 * parser que no alucina: si detecta una expresión de fecha conocida, ESA es la
 * verdad, y el `day` que mande el modelo pasa a ser solo un respaldo para
 * expresiones que el parser no cubre.
 *
 * Deliberadamente NO intenta entender lenguaje natural arbitrario — solo el
 * catálogo cerrado de expresiones que se listan abajo. Fuera de ese catálogo,
 * devuelve `null` y el `day` del modelo (si lo hay) sigue siendo lo único
 * disponible.
 */

export type TargetDateMatch = {
  /** Fecha resuelta, YYYY-MM-DD. */
  iso: string;
  /** El fragmento de texto que disparó el match — para depurar/loguear. */
  matchedText: string;
};

const WEEKDAY_NAMES: Record<string, WeekdayKey> = {
  lunes: "mon",
  martes: "tue",
  miercoles: "wed",
  jueves: "thu",
  viernes: "fri",
  sabado: "sat",
  domingo: "sun",
};

const MONTH_NAMES: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

/** minúsculas y sin acentos, para no fallar por "miércoles" vs "miercoles". */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** DD/MM[/YYYY] o DD-MM[-YYYY] → YYYY-MM-DD, corrigiendo al año siguiente si ya pasó. */
function resolveNumericDate(
  day: number,
  month: number,
  year: number | undefined,
  todayISO: string
): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const todayYear = Number(todayISO.slice(0, 4));
  let y = year ?? todayYear;
  let candidate = `${y}-${pad2(month)}-${pad2(day)}`;
  if (Number.isNaN(Date.parse(candidate))) return null;
  // Sin año explícito: si esa fecha ya pasó este año, es del año que viene —
  // nadie agenda "el 3 de enero" para hace ocho meses.
  if (year === undefined && candidate < todayISO) {
    y += 1;
    candidate = `${y}-${pad2(month)}-${pad2(day)}`;
  }
  return candidate;
}

/** Próxima fecha (>= hoy) cuyo día de semana sea `target`, en la zona del negocio. */
function nextWeekday(target: WeekdayKey, todayISO: string, tz: string): string {
  for (let i = 0; i < 8; i++) {
    const candidate = addDaysISO(todayISO, i);
    if (weekdayKeyOf(candidate, tz) === target) return candidate;
  }
  return todayISO; // inalcanzable: weekdayKeyOf cubre los 7 días
}

/**
 * Resuelve la primera expresión de fecha reconocida en `text`. `null` si no
 * hay ninguna — el llamador decide qué hacer (usar el `day` del modelo, o
 * nada).
 *
 * Cubre: hoy, mañana, pasado mañana, lunes..domingo (con o sin "este"/
 * "próximo"/"próxima" — ver nota abajo), y fechas explícitas
 * (YYYY-MM-DD, DD/MM[/YYYY], "DD de <mes>[ de YYYY]").
 *
 * Nota sobre "este sábado" vs "próximo sábado": en español mexicano ambas
 * formas casi siempre apuntan al MISMO sábado más próximo (la distinción
 * "esta semana" / "la que sigue" no es consistente entre hablantes) — así que
 * ambas resuelven igual aquí. Es una simplificación deliberada, no un olvido.
 */
export function resolveTargetDate(
  text: string,
  now: Date,
  tz: string
): TargetDateMatch | null {
  const todayISO = todayInTz(now, tz);
  const norm = normalize(text);

  // 1) Fecha ISO explícita: 2026-09-19
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(norm);
  if (iso) {
    const resolved = resolveNumericDate(
      Number(iso[3]),
      Number(iso[2]),
      Number(iso[1]),
      todayISO
    );
    if (resolved) return { iso: resolved, matchedText: iso[0] };
  }

  // 2) DD/MM[/YYYY] o DD-MM[-YYYY]
  const numeric = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}))?\b/.exec(norm);
  if (numeric) {
    const resolved = resolveNumericDate(
      Number(numeric[1]),
      Number(numeric[2]),
      numeric[3] ? Number(numeric[3]) : undefined,
      todayISO
    );
    if (resolved) return { iso: resolved, matchedText: numeric[0] };
  }

  // 3) "19 de septiembre [de 2026]"
  const monthNamePattern = Object.keys(MONTH_NAMES).join("|");
  const worded = new RegExp(
    `\\b(\\d{1,2}) de (${monthNamePattern})(?: de (\\d{4}))?\\b`
  ).exec(norm);
  if (worded) {
    const resolved = resolveNumericDate(
      Number(worded[1]),
      MONTH_NAMES[worded[2]!]!,
      worded[3] ? Number(worded[3]) : undefined,
      todayISO
    );
    if (resolved) return { iso: resolved, matchedText: worded[0] };
  }

  // 4) "pasado mañana" — se revisa ANTES que "mañana" (la contiene).
  if (/\bpasado\s+manana\b/.test(norm)) {
    return { iso: addDaysISO(todayISO, 2), matchedText: "pasado mañana" };
  }

  // 5) "mañana" (día siguiente — no el sentido de "en la mañana"/horario; ver
  // docstring del módulo: catálogo cerrado, ambigüedad conocida y aceptada).
  if (/\bmanana\b/.test(norm)) {
    return { iso: addDaysISO(todayISO, 1), matchedText: "mañana" };
  }

  // 6) "hoy"
  if (/\bhoy\b/.test(norm)) {
    return { iso: todayISO, matchedText: "hoy" };
  }

  // 7) Nombre de día de la semana, con o sin "este"/"próximo(a)" delante.
  for (const [name, key] of Object.entries(WEEKDAY_NAMES)) {
    const re = new RegExp(`\\b(?:este |esta |proximo |proxima |el )?${name}\\b`);
    const match = re.exec(norm);
    if (match) {
      return { iso: nextWeekday(key, todayISO, tz), matchedText: match[0].trim() };
    }
  }

  return null;
}

export type BusinessHoursFact = {
  targetDate: string;
  dayOfWeek: WeekdayKey | null;
  businessOpen: boolean;
  /** "09:00-17:00" (o varios intervalos separados por coma), o "cerrado". */
  businessHours: string;
  timezone: string;
};

/**
 * La verdad de horario para UNA fecha, tal como debe llegar al LLM: nunca
 * "el modelo sabe si el domingo se trabaja" — esto es lo único que puede
 * decir "abierto" o "cerrado".
 */
export function businessHoursFact(
  targetDate: string,
  weeklyHours: Partial<Record<WeekdayKey, { start: string; end: string }[]>>,
  timezone: string
): BusinessHoursFact {
  const dayOfWeek = weekdayKeyOf(targetDate, timezone);
  const intervals = dayOfWeek ? weeklyHours[dayOfWeek] ?? [] : [];
  const businessOpen = intervals.length > 0;
  return {
    targetDate,
    dayOfWeek,
    businessOpen,
    businessHours: businessOpen
      ? intervals.map((iv) => `${iv.start}-${iv.end}`).join(", ")
      : "cerrado",
    timezone,
  };
}
