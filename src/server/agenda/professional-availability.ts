import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  addDaysISO,
  eachDateInRange,
  todayInTz,
  weekdayKeyOf,
  zonedWallClockToUtc,
  type SlotUtc,
} from "@/lib/time/slots";
import {
  buildCandidateSlots,
  filterFreeSlots,
  type AvailableSlot,
} from "@/server/agenda/availability";
import { getSettings } from "@/server/agenda/settings";
import { BeautyCatalogError } from "@/server/beauty/catalog";

const DAY_TO_NUMBER: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const minuteLabel = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

export async function getSchedulingContext(input: {
  organizationId: string;
  serviceId: string;
  professionalId: string;
}) {
  const db = getDb();
  const rows = await db
    .select({
      service: schema.service,
      professional: schema.professional,
    })
    .from(schema.professionalService)
    .innerJoin(
      schema.service,
      and(
        eq(schema.professionalService.serviceId, schema.service.id),
        eq(schema.service.organizationId, schema.professionalService.organizationId)
      )
    )
    .innerJoin(
      schema.professional,
      and(
        eq(schema.professionalService.professionalId, schema.professional.id),
        eq(
          schema.professional.organizationId,
          schema.professionalService.organizationId
        )
      )
    )
    .where(
      scoped(
        schema.professionalService.organizationId,
        input.organizationId,
        eq(schema.professionalService.serviceId, input.serviceId),
        eq(schema.professionalService.professionalId, input.professionalId),
        eq(schema.service.active, true),
        eq(schema.professional.status, "active")
      )
    )
    .limit(1);
  if (!rows[0]) {
    throw new BeautyCatalogError(
      "not_found",
      "El servicio y la profesional no forman una opción activa de esta organización"
    );
  }
  return rows[0];
}

export async function computeProfessionalAvailability(
  organizationId: string,
  input: {
    serviceId: string;
    professionalId: string;
    fromISO?: string;
    toISO?: string;
    excludeBookingId?: string;
    now?: Date;
  }
): Promise<AvailableSlot[]> {
  const db = getDb();
  const context = await getSchedulingContext({ organizationId, ...input });
  const baseSettings = await getSettings(organizationId);
  const now = input.now ?? new Date();
  const timezone = context.professional.timezone;
  const from = input.fromISO ?? todayInTz(now, timezone);
  const to = input.toISO ?? addDaysISO(from, baseSettings.maxDaysAhead);

  const [weeklyRows, breakRows, timeOffRows, bookingRows] = await Promise.all([
    db
      .select()
      .from(schema.professionalAvailability)
      .where(
        scoped(
          schema.professionalAvailability.organizationId,
          organizationId,
          eq(
            schema.professionalAvailability.professionalId,
            input.professionalId
          )
        )
      ),
    db
      .select()
      .from(schema.professionalBreak)
      .where(
        scoped(
          schema.professionalBreak.organizationId,
          organizationId,
          eq(schema.professionalBreak.professionalId, input.professionalId)
        )
      ),
    db
      .select({
        startsAt: schema.professionalTimeOff.startsAt,
        endsAt: schema.professionalTimeOff.endsAt,
      })
      .from(schema.professionalTimeOff)
      .where(
        scoped(
          schema.professionalTimeOff.organizationId,
          organizationId,
          eq(schema.professionalTimeOff.professionalId, input.professionalId),
          lte(
            schema.professionalTimeOff.startsAt,
            zonedWallClockToUtc(addDaysISO(to, 1), "00:00", timezone)!
          ),
          gte(
            schema.professionalTimeOff.endsAt,
            zonedWallClockToUtc(from, "00:00", timezone)!
          )
        )
      ),
    db
      .select({
        id: schema.booking.id,
        scheduledAt: schema.booking.scheduledAt,
        durationMinutes: schema.booking.durationMinutes,
      })
      .from(schema.booking)
      .where(
        scoped(
          schema.booking.organizationId,
          organizationId,
          eq(schema.booking.professionalId, input.professionalId),
          inArray(schema.booking.status, ["agendada", "realizada"]),
          eq(schema.booking.isTest, false)
        )
      ),
  ]);

  const weeklyHours: Record<string, Array<{ start: string; end: string }>> = {};
  for (const row of weeklyRows) {
    const key = Object.entries(DAY_TO_NUMBER).find(([, day]) => day === row.dayOfWeek)?.[0];
    if (!key) continue;
    (weeklyHours[key] ??= []).push({
      start: minuteLabel(row.startMinute),
      end: minuteLabel(row.endMinute),
    });
  }
  const settings = {
    ...baseSettings,
    weeklyHours,
    timezone,
    slotMinutes: context.service.durationMinutes,
    bufferMinutes:
      context.service.bufferBeforeMinutes + context.service.bufferAfterMinutes,
  };
  const candidates = buildCandidateSlots(settings, from, to);
  const busy: SlotUtc[] = [
    ...bookingRows
      .filter((row) => row.id !== input.excludeBookingId)
      .map((row) => ({
        startUtc: row.scheduledAt.toISOString(),
        endUtc: new Date(
          row.scheduledAt.getTime() + row.durationMinutes * 60_000
        ).toISOString(),
      })),
    ...timeOffRows.map((row) => ({
      startUtc: row.startsAt.toISOString(),
      endUtc: row.endsAt.toISOString(),
    })),
  ];
  for (const date of eachDateInRange(from, to)) {
    const weekday = weekdayKeyOf(date, timezone);
    const dayNumber = weekday ? DAY_TO_NUMBER[weekday] : undefined;
    if (dayNumber === undefined) continue;
    for (const rest of breakRows.filter((row) => row.dayOfWeek === dayNumber)) {
      const start = zonedWallClockToUtc(date, minuteLabel(rest.startMinute), timezone);
      const end = zonedWallClockToUtc(date, minuteLabel(rest.endMinute), timezone);
      if (start && end) {
        busy.push({ startUtc: start.toISOString(), endUtc: end.toISOString() });
      }
    }
  }
  return filterFreeSlots(candidates, busy, {
    now,
    minNoticeHours: settings.minNoticeHours,
    timezone,
  });
}

export async function findProfessionalSlot(
  organizationId: string,
  input: {
    serviceId: string;
    professionalId: string;
    startUtc: string;
    excludeBookingId?: string;
    now?: Date;
  }
) {
  const target = Date.parse(input.startUtc);
  if (Number.isNaN(target)) return null;
  const context = await getSchedulingContext({ organizationId, ...input });
  const day = todayInTz(new Date(target), context.professional.timezone);
  const slots = await computeProfessionalAvailability(organizationId, {
    ...input,
    fromISO: addDaysISO(day, -1),
    toISO: addDaysISO(day, 1),
  });
  return slots.find((slot) => Date.parse(slot.startUtc) === target) ?? null;
}
