import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { BeautyCatalogError } from "@/server/beauty/catalog";

export type WeeklyInterval = {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
};

export type TimeOffInterval = {
  startsAt: string;
  endsAt: string;
  reason?: string | null;
};

export function validateWeeklyIntervals(
  intervals: WeeklyInterval[],
  label: string
): void {
  const byDay = new Map<number, WeeklyInterval[]>();
  for (const interval of intervals) {
    if (
      !Number.isInteger(interval.dayOfWeek) ||
      interval.dayOfWeek < 0 ||
      interval.dayOfWeek > 6 ||
      !Number.isInteger(interval.startMinute) ||
      !Number.isInteger(interval.endMinute) ||
      interval.startMinute < 0 ||
      interval.endMinute > 1440 ||
      interval.startMinute >= interval.endMinute
    ) {
      throw new BeautyCatalogError("invalid", `${label}: intervalo inválido`);
    }
    const day = byDay.get(interval.dayOfWeek) ?? [];
    day.push(interval);
    byDay.set(interval.dayOfWeek, day);
  }
  for (const day of byDay.values()) {
    day.sort((a, b) => a.startMinute - b.startMinute);
    for (let index = 1; index < day.length; index += 1) {
      if (day[index]!.startMinute < day[index - 1]!.endMinute) {
        throw new BeautyCatalogError("invalid", `${label}: intervalos traslapados`);
      }
    }
  }
}

export async function getProfessionalAvailability(
  organizationId: string,
  professionalId: string
) {
  const db = getDb();
  await assertOwnProfessional(db, organizationId, professionalId);
  const [weekly, breaks, timeOff] = await Promise.all([
    db
      .select()
      .from(schema.professionalAvailability)
      .where(
        scoped(
          schema.professionalAvailability.organizationId,
          organizationId,
          eq(schema.professionalAvailability.professionalId, professionalId)
        )
      )
      .orderBy(
        asc(schema.professionalAvailability.dayOfWeek),
        asc(schema.professionalAvailability.startMinute)
      ),
    db
      .select()
      .from(schema.professionalBreak)
      .where(
        scoped(
          schema.professionalBreak.organizationId,
          organizationId,
          eq(schema.professionalBreak.professionalId, professionalId)
        )
      )
      .orderBy(
        asc(schema.professionalBreak.dayOfWeek),
        asc(schema.professionalBreak.startMinute)
      ),
    db
      .select()
      .from(schema.professionalTimeOff)
      .where(
        scoped(
          schema.professionalTimeOff.organizationId,
          organizationId,
          eq(schema.professionalTimeOff.professionalId, professionalId)
        )
      )
      .orderBy(asc(schema.professionalTimeOff.startsAt)),
  ]);
  return { weekly, breaks, timeOff };
}

export async function replaceProfessionalAvailability(input: {
  organizationId: string;
  professionalId: string;
  weekly: WeeklyInterval[];
  breaks: WeeklyInterval[];
  timeOff: TimeOffInterval[];
}) {
  validateWeeklyIntervals(input.weekly, "Horario");
  validateWeeklyIntervals(input.breaks, "Descansos");
  for (const interval of input.timeOff) {
    if (
      Number.isNaN(Date.parse(interval.startsAt)) ||
      Number.isNaN(Date.parse(interval.endsAt)) ||
      Date.parse(interval.startsAt) >= Date.parse(interval.endsAt)
    ) {
      throw new BeautyCatalogError("invalid", "Ausencia con fechas inválidas");
    }
  }

  const db = getDb();
  await db.transaction(async (tx) => {
    await assertOwnProfessional(tx, input.organizationId, input.professionalId);
    await tx
      .delete(schema.professionalAvailability)
      .where(
        scoped(
          schema.professionalAvailability.organizationId,
          input.organizationId,
          eq(schema.professionalAvailability.professionalId, input.professionalId)
        )
      );
    await tx
      .delete(schema.professionalBreak)
      .where(
        scoped(
          schema.professionalBreak.organizationId,
          input.organizationId,
          eq(schema.professionalBreak.professionalId, input.professionalId)
        )
      );
    await tx
      .delete(schema.professionalTimeOff)
      .where(
        scoped(
          schema.professionalTimeOff.organizationId,
          input.organizationId,
          eq(schema.professionalTimeOff.professionalId, input.professionalId)
        )
      );

    if (input.weekly.length > 0) {
      await tx.insert(schema.professionalAvailability).values(
        input.weekly.map((interval) => ({
          id: newId("professionalAvailability"),
          organizationId: input.organizationId,
          professionalId: input.professionalId,
          ...interval,
        }))
      );
    }
    if (input.breaks.length > 0) {
      await tx.insert(schema.professionalBreak).values(
        input.breaks.map((interval) => ({
          id: newId("professionalBreak"),
          organizationId: input.organizationId,
          professionalId: input.professionalId,
          ...interval,
        }))
      );
    }
    if (input.timeOff.length > 0) {
      await tx.insert(schema.professionalTimeOff).values(
        input.timeOff.map((interval) => ({
          id: newId("professionalTimeOff"),
          organizationId: input.organizationId,
          professionalId: input.professionalId,
          startsAt: new Date(interval.startsAt),
          endsAt: new Date(interval.endsAt),
          reason: interval.reason?.trim() || null,
        }))
      );
    }
  });

  return getProfessionalAvailability(input.organizationId, input.professionalId);
}

type QueryDb = Pick<ReturnType<typeof getDb>, "select">;

async function assertOwnProfessional(
  db: QueryDb,
  organizationId: string,
  professionalId: string
) {
  const rows = await db
    .select({ id: schema.professional.id })
    .from(schema.professional)
    .where(
      scoped(
        schema.professional.organizationId,
        organizationId,
        eq(schema.professional.id, professionalId)
      )
    )
    .limit(1);
  if (!rows[0]) {
    throw new BeautyCatalogError("not_found", "Profesional no encontrado");
  }
}
