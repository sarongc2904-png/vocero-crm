import { computeAvailability, type AvailableSlot } from "@/server/agenda/availability";
import { getSettings } from "@/server/agenda/settings";
import { spreadByDay } from "@/server/agenda/spread";
import { replaceOffers } from "@/server/agenda/offers";
import { BookingError, createSessionBooking } from "@/server/agenda/service";
import { googleAddEventUrl } from "@/lib/calendar-link";
import { dayIsoInTz, dayLabelInTz, timeInTz } from "@/lib/time/slots";
import { capitalize, formatHoursEs } from "@/server/agenda/schedule-intent";

const DAY_ISO = /^\d{4}-\d{2}-\d{2}$/;

export type AgendaTurn = {
  text: string;
  ok: boolean;
  pagination?: SchedulePagination;
};

export type SchedulePagination = {
  totalAvailableSlots: number;
  displayedSlots: number;
  totalAvailableDays: number;
  displayedDays: number;
  remainingSlots: number;
  remainingDays: number;
  truncated: boolean;
};

function enrichAll(slots: AvailableSlot[], timezone: string, now: Date) {
  const count = Math.max(1, slots.length);
  return spreadByDay(slots, {
    timezone,
    limit: count,
    perDay: count,
    now,
  });
}

/**
 * WhatsApp: muestra el día una sola vez y cada hora en su propia línea.
 * Conserva TODOS los slots recibidos; solo cambia la presentación.
 */
function formatSlotBlocks(
  slots: ReturnType<typeof enrichAll>,
  timezone: string,
  now: Date
): string {
  const byDay = new Map<string, typeof slots>();
  for (const slot of slots) {
    const day = dayIsoInTz(new Date(slot.startUtc), timezone);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(slot);
    else byDay.set(day, [slot]);
  }

  return [...byDay.values()]
    .map((daySlots) => {
      const title = capitalize(dayLabelInTz(daySlots[0]!.startUtc, timezone, now));
      const times = daySlots.map((slot) => `• ${slot.time}`).join("\n");
      return `${title}\n${times}`;
    })
    .join("\n\n");
}

/**
 * `intro` puede venir del modelo. Solo se acepta si es una frase breve: nunca
 * dejamos que un horario, una lista o varias líneas generadas por el LLM se
 * mezclen con los slots factuales del backend.
 */
function safeOfferIntro(intro?: string): string | undefined {
  const value = intro?.trim();
  if (!value) return undefined;
  if (value.includes("\n") || /[•▪◦]/.test(value)) return undefined;
  if (/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(value)) return undefined;
  if (/\b\d{1,2}\s*(?:a\.?\s*m\.?|p\.?\s*m\.?)\b/i.test(value)) return undefined;
  return value;
}

export async function offerSlots(input: {
  organizationId: string;
  conversationId: string;
  intro?: string;
  day?: string;
  businessFact?: { businessOpen: boolean; businessHours: string; dateLabel: string };
}): Promise<AgendaTurn> {
  const settings = await getSettings(input.organizationId);
  const now = new Date();
  const all = await computeAvailability(input.organizationId, { settings, now });
  const spread = enrichAll(all, settings.timezone, now);

  const dayAvailabilityRaw =
    input.day && DAY_ISO.test(input.day)
      ? await computeAvailability(input.organizationId, {
          settings,
          now,
          fromISO: input.day,
          toISO: input.day,
        })
      : [];
  const dayAvailability = input.day
    ? dayAvailabilityRaw.filter(
        (slot) => dayIsoInTz(new Date(slot.startUtc), settings.timezone) === input.day
      )
    : dayAvailabilityRaw;
  const dayShown = enrichAll(dayAvailability, settings.timezone, now);

  const requestedDayHasAvailability = Boolean(input.day) && dayShown.length > 0;
  const catalog = requestedDayHasAvailability ? dayShown : spread;
  if (catalog.length === 0) {
    return {
      ok: false,
      text: "Por ahora no me quedan horarios libres. Déjame confirmarlo con el equipo y te aviso.",
    };
  }

  await replaceOffers(
    input.organizationId,
    input.conversationId,
    catalog.map((slot) => ({ startUtc: slot.startUtc, label: slot.label }))
  );

  if (input.day) {
    if (requestedDayHasAvailability) {
      const list = formatSlotBlocks(dayShown, settings.timezone, now);
      const intro = safeOfferIntro(input.intro) || "Tengo estos horarios disponibles:";
      return { ok: true, text: `${intro}\n${list}` };
    }

    const list = formatSlotBlocks(spread, settings.timezone, now);
    const heading = input.businessFact
      ? input.businessFact.businessOpen
        ? `Sí abrimos ${input.businessFact.dateLabel} de ${formatHoursEs(input.businessFact.businessHours)}, pero ya no tengo horarios disponibles ese día.`
        : `${capitalize(input.businessFact.dateLabel)} estamos cerrados.`
      : "Ese día no tengo horarios disponibles.";
    return {
      ok: true,
      text: `${heading} Estas son mis próximas opciones:\n${list}`,
    };
  }

  const list = formatSlotBlocks(spread, settings.timezone, now);
  const intro = safeOfferIntro(input.intro) || "Tengo estos horarios disponibles:";
  return { ok: true, text: `${intro}\n${list}` };
}

async function offerGrouped(input: {
  organizationId: string;
  conversationId: string;
  fromISO?: string;
  toISO?: string;
  emptyText: string;
  heading: string;
}): Promise<AgendaTurn> {
  const settings = await getSettings(input.organizationId);
  const now = new Date();
  const all = await computeAvailability(input.organizationId, {
    settings,
    now,
    fromISO: input.fromISO,
    toISO: input.toISO,
  });
  if (all.length === 0) return { ok: false, text: input.emptyText };

  const byDay = new Map<string, AvailableSlot[]>();
  for (const slot of all) {
    const day = dayIsoInTz(new Date(slot.startUtc), settings.timezone);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(slot);
    else byDay.set(day, [slot]);
  }

  await replaceOffers(
    input.organizationId,
    input.conversationId,
    all.map((slot) => ({ startUtc: slot.startUtc, label: slot.label }))
  );

  const blocks = [...byDay.values()].map((slots) => {
    const title = capitalize(dayLabelInTz(slots[0]!.startUtc, settings.timezone, now));
    const times = slots
      .map((slot) => `• ${timeInTz(slot.startUtc, settings.timezone)}`)
      .join("\n");
    return `${title}\n${times}`;
  });

  const totalAvailableDays = byDay.size;
  const totalAvailableSlots = all.length;
  const pagination: SchedulePagination = {
    totalAvailableSlots,
    displayedSlots: totalAvailableSlots,
    totalAvailableDays,
    displayedDays: totalAvailableDays,
    remainingSlots: 0,
    remainingDays: 0,
    truncated: false,
  };

  return {
    ok: true,
    text: `${input.heading}\n\n${blocks.join("\n\n")}`,
    pagination,
  };
}

export async function offerRange(input: {
  organizationId: string;
  conversationId: string;
  startDate: string;
  endDate: string;
}): Promise<AgendaTurn> {
  return offerGrouped({
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    fromISO: input.startDate,
    toISO: input.endDate,
    emptyText: "No tengo horarios disponibles en ese rango de fechas. ¿Te gustaría que revise otras fechas?",
    heading: "Estos son los horarios disponibles:",
  });
}

export async function offerGeneralAvailability(input: {
  organizationId: string;
  conversationId: string;
}): Promise<AgendaTurn> {
  return offerGrouped({
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    emptyText: "Por ahora no me quedan horarios libres. Déjame confirmarlo con el equipo y te aviso.",
    heading: "Esta es la disponibilidad que tengo:",
  });
}

export async function offerNextAvailable(input: {
  organizationId: string;
  conversationId: string;
}): Promise<AgendaTurn> {
  const settings = await getSettings(input.organizationId);
  const now = new Date();
  const all = await computeAvailability(input.organizationId, { settings, now });
  if (all.length === 0) {
    return {
      ok: false,
      text: "Por ahora no tengo horarios libres. Déjame confirmarlo con el equipo y te aviso.",
    };
  }
  const first = all[0]!;
  await replaceOffers(input.organizationId, input.conversationId, [
    { startUtc: first.startUtc, label: first.label },
  ]);
  return { ok: true, text: `La próxima cita disponible es ${first.label}. ¿Te la agendo?` };
}

export async function bookSlot(input: {
  organizationId: string;
  conversationId: string;
  startUtc: string;
}): Promise<AgendaTurn> {
  try {
    const result = await createSessionBooking({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      startUtc: input.startUtc,
      source: "ai",
      requireOffer: true,
    });

    const base = `¡Listo! Te agendé para ${result.label}.`;
    const reminder = googleAddEventUrl({
      title: "Tu cita",
      startUtc: input.startUtc,
      durationMinutes: result.booking.durationMinutes,
    });
    const withReminder = (text: string) =>
      `${text}\nAgrega la cita a tu calendario: ${reminder}`;

    if (result.meetingLink) {
      return { ok: true, text: withReminder(`${base}\nEnlace: ${result.meetingLink}`) };
    }
    if (result.linkPending) {
      return {
        ok: true,
        text: withReminder(`${base}\nEn un momento te comparto el enlace por aquí.`),
      };
    }
    return { ok: true, text: withReminder(base) };
  } catch (err) {
    if (!(err instanceof BookingError)) throw err;

    if (err.slots.length > 0) {
      const list = err.slots.map((slot) => `• ${slot.label}`).join("\n");
      const apology =
        err.code === "slot_taken"
          ? "Se me acaba de ocupar ese horario, ¡perdón!"
          : "Déjame confirmarte los horarios que tengo:";
      return { ok: false, text: `${apology}\n${list}` };
    }
    return {
      ok: false,
      text: "No pude agendarlo en este momento. Lo reviso con el equipo y te confirmo.",
    };
  }
}
