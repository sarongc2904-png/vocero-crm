import { addDaysISO, todayInTz, weekdayKeyOf, type WeekdayKey } from "@/lib/time/slots";

/**
 * Resolución DETERMINISTA de la fecha pedida por el cliente.
 * El LLM nunca es fuente de verdad para fechas de agenda.
 */
export type TargetDateMatch = {
  iso: string;
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

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Valida calendario real; evita aceptar 31/02 o 29/02 en año no bisiesto. */
function validCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

function resolveNumericDate(
  day: number,
  month: number,
  year: number | undefined,
  todayISO: string
): string | null {
  const todayYear = Number(todayISO.slice(0, 4));
  let y = year ?? todayYear;
  if (!validCalendarDate(y, month, day)) return null;

  let candidate = `${y}-${pad2(month)}-${pad2(day)}`;
  if (year === undefined && candidate < todayISO) {
    y += 1;
    if (!validCalendarDate(y, month, day)) return null;
    candidate = `${y}-${pad2(month)}-${pad2(day)}`;
  }
  return candidate;
}

function nextWeekday(target: WeekdayKey, todayISO: string, tz: string): string {
  for (let i = 0; i < 8; i++) {
    const candidate = addDaysISO(todayISO, i);
    if (weekdayKeyOf(candidate, tz) === target) return candidate;
  }
  return todayISO;
}

export function resolveTargetDate(
  text: string,
  now: Date,
  tz: string
): TargetDateMatch | null {
  const todayISO = todayInTz(now, tz);
  const norm = normalize(text);

  // 1) Fecha ISO explícita.
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

  // 2) DD/MM[/YYYY] o DD-MM[-YYYY].
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

  // 3) "19 de septiembre [de 2026]".
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

  // 4) "pasado mañana" antes de "mañana".
  if (/\bpasado\s+manana\b/.test(norm)) {
    return { iso: addDaysISO(todayISO, 2), matchedText: "pasado mañana" };
  }

  // 5) "mañana" = día siguiente, PERO no cuando solo significa daypart:
  // "en la mañana", "por la mañana", "de la mañana". Si el usuario dice
  // "mañana por la mañana", al quitar el daypart queda el primer "mañana" y
  // se resuelve correctamente como día siguiente.
  const withoutMorningDaypart = norm.replace(
    /\b(?:en|por|de)\s+la\s+manana\b/g,
    " "
  );
  if (/\bmanana\b/.test(withoutMorningDaypart)) {
    return { iso: addDaysISO(todayISO, 1), matchedText: "mañana" };
  }

  // 6) "hoy".
  if (/\bhoy\b/.test(norm)) {
    return { iso: todayISO, matchedText: "hoy" };
  }

  // 7) Nombre de día.
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
  businessHours: string;
  timezone: string;
};

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
