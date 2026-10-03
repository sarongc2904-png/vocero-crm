import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import type { WeeklyHours } from "@/server/agenda/settings";

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type DayKey = (typeof DAY_KEYS)[number];

const DAY_LABELS: Record<DayKey, string> = {
  mon: "Lunes",
  tue: "Martes",
  wed: "Miércoles",
  thu: "Jueves",
  fri: "Viernes",
  sat: "Sábado",
  sun: "Domingo",
};

type ExpectedHours = { start: string | null; end: string };

export type ScheduleDifference = {
  day: string;
  document: string;
  agenda: string;
};

export type ScheduleCoherence = {
  status: "matches" | "differences" | "unverifiable";
  message: string;
  differences: ScheduleDifference[];
  shortBookingWindow: boolean;
  maxDaysAhead: number | null;
};

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[–—]/g, "-");
}

function time(hourRaw: string, minuteRaw?: string): string | null {
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw ?? "0");
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function mentionedDays(segment: string): DayKey[] {
  const days = new Set<DayKey>();
  if (/\b(?:lunes\s+(?:a|-)\s*viernes|l\s*-\s*v)\b/.test(segment)) {
    for (const day of ["mon", "tue", "wed", "thu", "fri"] as const) days.add(day);
  }
  const patterns: Array<[DayKey, RegExp]> = [
    ["mon", /\blunes\b/],
    ["tue", /\bmartes\b/],
    ["wed", /\bmiercoles\b/],
    ["thu", /\bjueves\b/],
    ["fri", /\bviernes\b/],
    ["sat", /\bsabado\b/],
    ["sun", /\bdomingo\b/],
  ];
  for (const [day, pattern] of patterns) if (pattern.test(segment)) days.add(day);
  return [...days];
}

export function extractDocumentHours(
  documentText: string
): Partial<Record<DayKey, ExpectedHours[]>> {
  const expected: Partial<Record<DayKey, ExpectedHours[]>> = {};
  const segments = normalizeText(documentText)
    .split(/[\n.;]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const segment of segments) {
    const days = mentionedDays(segment);
    if (days.length === 0) continue;

    const range = segment.match(
      /(?:\bde\s+)?(\d{1,2})(?::(\d{2}))?\s*(?:a|-)\s*(\d{1,2})(?::(\d{2}))?\b/
    );
    const until = segment.match(/\bhasta\s+(?:las\s+)?(\d{1,2})(?::(\d{2}))?\b/);
    let hours: ExpectedHours | null = null;
    if (range) {
      const start = time(range[1]!, range[2]);
      const end = time(range[3]!, range[4]);
      if (start && end && start < end) hours = { start, end };
    } else if (until) {
      const end = time(until[1]!, until[2]);
      if (end) hours = { start: null, end };
    }
    if (!hours) continue;

    for (const day of days) {
      const entries = expected[day] ?? [];
      if (!entries.some((entry) => entry.start === hours.start && entry.end === hours.end)) {
        entries.push(hours);
      }
      expected[day] = entries;
    }
  }
  return expected;
}

function agendaLabel(intervals: Array<{ start: string; end: string }>) {
  return intervals.length
    ? intervals.map((interval) => `${interval.start}-${interval.end}`).join(", ")
    : "cerrado";
}

function documentLabel(entries: ExpectedHours[]) {
  return entries
    .map((entry) => (entry.start ? `${entry.start}-${entry.end}` : `hasta ${entry.end}`))
    .join(", ");
}

export function analyzeScheduleCoherence(input: {
  weeklyHours: WeeklyHours;
  maxDaysAhead: number;
  documentText: string;
}): ScheduleCoherence {
  const expected = extractDocumentHours(input.documentText);
  const expectedDays = DAY_KEYS.filter((day) => expected[day]?.length);
  const shortBookingWindow = input.maxDaysAhead < 14;
  if (expectedDays.length === 0) {
    return {
      status: "unverifiable",
      message: "No se pudo verificar: el documento no menciona horarios con suficiente precisión.",
      differences: [],
      shortBookingWindow,
      maxDaysAhead: input.maxDaysAhead,
    };
  }

  const differences: ScheduleDifference[] = [];
  for (const day of expectedDays) {
    const documentHours = expected[day] ?? [];
    const agendaHours = input.weeklyHours[day] ?? [];
    const fullRanges = documentHours.filter((entry) => entry.start);
    const endOnly = documentHours.filter((entry) => !entry.start);
    const fullMatch =
      fullRanges.length === 0 ||
      (fullRanges.length === agendaHours.length &&
        fullRanges.every((entry) =>
          agendaHours.some(
            (interval) => interval.start === entry.start && interval.end === entry.end
          )
        ));
    const latestAgendaEnd = agendaHours
      .map((interval) => interval.end)
      .sort()
      .at(-1);
    const endMatch = endOnly.every((entry) => latestAgendaEnd === entry.end);
    if (!fullMatch || !endMatch) {
      differences.push({
        day: DAY_LABELS[day],
        document: documentLabel(documentHours),
        agenda: agendaLabel(agendaHours),
      });
    }
  }

  return differences.length
    ? {
        status: "differences",
        message: "La agenda y el documento mencionan horarios diferentes.",
        differences,
        shortBookingWindow,
        maxDaysAhead: input.maxDaysAhead,
      }
    : {
        status: "matches",
        message: "Los horarios verificables del documento coinciden con la agenda.",
        differences: [],
        shortBookingWindow,
        maxDaysAhead: input.maxDaysAhead,
      };
}

export async function getScheduleCoherence(
  organizationId: string
): Promise<ScheduleCoherence> {
  const db = getDb();
  const settingsRows = await db
    .select({
      weeklyHours: schema.calendarSettings.weeklyHours,
      maxDaysAhead: schema.calendarSettings.maxDaysAhead,
    })
    .from(schema.calendarSettings)
    .where(scoped(schema.calendarSettings.organizationId, organizationId))
    .limit(1);
  const settings = settingsRows[0];
  if (!settings) {
    return {
      status: "unverifiable",
      message: "No se pudo verificar: configura primero la agenda del negocio.",
      differences: [],
      shortBookingWindow: false,
      maxDaysAhead: null,
    };
  }

  const chunks = await db
    .select({
      content: schema.kbDocumentChunk.content,
    })
    .from(schema.kbDocumentChunk)
    .innerJoin(
      schema.kbDocument,
      eq(schema.kbDocument.id, schema.kbDocumentChunk.documentId)
    )
    .where(
      scoped(
        schema.kbDocumentChunk.organizationId,
        organizationId,
        eq(schema.kbDocument.organizationId, organizationId),
        eq(schema.kbDocument.status, "ready"),
        eq(schema.kbDocumentChunk.approved, true)
      )
    )
    .orderBy(
      asc(schema.kbDocumentChunk.documentId),
      asc(schema.kbDocumentChunk.position)
    );

  return analyzeScheduleCoherence({
    weeklyHours: settings.weeklyHours as WeeklyHours,
    maxDaysAhead: settings.maxDaysAhead,
    documentText: chunks.map((chunk) => chunk.content).join("\n"),
  });
}
