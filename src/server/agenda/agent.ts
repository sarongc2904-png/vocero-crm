import { computeAvailability, type AvailableSlot } from "@/server/agenda/availability";
import { getSettings } from "@/server/agenda/settings";
import { spreadByDay, type SpreadSlot } from "@/server/agenda/spread";
import { replaceOffers } from "@/server/agenda/offers";
import { BookingError, createSessionBooking } from "@/server/agenda/service";
import { googleAddEventUrl } from "@/lib/calendar-link";
import { dayIsoInTz, dayLabelInTz, timeInTz, weekdayKeyOf } from "@/lib/time/slots";
import { capitalize, formatHoursEs } from "@/server/agenda/schedule-intent";
import { type ExpandWindow } from "@/server/agenda/expand";

const DAY_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 015 — Política de presentación compacta de disponibilidad en el chat.
 *
 * La herramienta conserva TODA la disponibilidad internamente (se persiste en
 * `offered_slot` para reservar/reprogramar con alternativas legítimas); lo que
 * se limita es SOLO lo que se muestra al cliente. Sin fecha → 1 día y pocos
 * horarios; un día pedido → ese día con tope; un día lleno → el día siguiente.
 * Ampliar más solo ante una petición explícita (otro día / más tarde / tarde /
 * mañana / fin de semana).
 */
export const COMPACT_PRESENTATION = {
  /** Horarios visibles al pedir disponibilidad sin fecha (1 día). */
  noDateSlots: 4,
  /** Horarios visibles al pedir un día concreto. */
  specificDaySlots: 5,
  /** Horarios visibles cuando el día pedido está lleno (día siguiente). */
  altDaySlots: 4,
  /** Horarios visibles al ampliar (otro día / tarde / mañana / fin de semana). */
  expandSlots: 4,
  /** Tope por día al pedir un rango explícito (mantiene la respuesta legible). */
  rangePerDaySlots: 4,
} as const;

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
export function formatSlotBlocks(
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

/** Días (YYYY-MM-DD) presentes en el catálogo, en orden cronológico. */
function distinctDays(slots: SpreadSlot[]): string[] {
  return [...new Set(slots.map((s) => s.dayIso))];
}

/** Los horarios del PRIMER día disponible, hasta `max`. */
function firstDaySlots(slots: SpreadSlot[], max: number): SpreadSlot[] {
  if (slots.length === 0) return [];
  const firstDay = slots[0]!.dayIso;
  return slots.filter((s) => s.dayIso === firstDay).slice(0, max);
}

/** "10:40" → 640 minutos. */
function timeMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * IA-3 — Ventana de ampliación, con CURSOR.
 *
 * `cursor` es el índice de ventana ya avanzado por el pipeline (0 = primera
 * ventana de ese criterio). Antes `next_day` devolvía siempre `days[1]`, así que
 * pedir "otros horarios" dos veces mostraba el mismo bloque.
 */
function windowSlots(
  slots: SpreadSlot[],
  window: ExpandWindow,
  timezone: string,
  cursor = 0
): SpreadSlot[] {
  const days = distinctDays(slots);
  const limit = COMPACT_PRESENTATION.expandSlots;
  const inDaypart = (day: string) =>
    slots.some(
      (s) =>
        s.dayIso === day &&
        (window === "afternoon"
          ? timeMinutes(s.time) >= 12 * 60
          : timeMinutes(s.time) < 12 * 60)
    );
  const isWeekendDay = (day: string) => {
    const weekday = weekdayKeyOf(day, timezone);
    return weekday === "sat" || weekday === "sun";
  };

  if (window === "next_day") {
    // El día 0 es el de la oferta base; el cursor empieza en el siguiente.
    const target = days[1 + cursor];
    if (!target) return [];
    return slots.filter((s) => s.dayIso === target).slice(0, limit);
  }

  // morning / afternoon / weekend: la (cursor)-ésima jornada que cumple el
  // criterio, para que también avancen en vez de repetirse.
  const matchingDays = days.filter((day) =>
    window === "weekend" ? isWeekendDay(day) : inDaypart(day)
  );
  const target = matchingDays[cursor];
  if (!target) return [];
  if (window === "weekend") {
    return slots.filter((s) => s.dayIso === target).slice(0, limit);
  }
  return slots
    .filter(
      (s) =>
        s.dayIso === target &&
        (window === "afternoon"
          ? timeMinutes(s.time) >= 12 * 60
          : timeMinutes(s.time) < 12 * 60)
    )
    .slice(0, limit);
}

function expandIntro(window: ExpandWindow): string {
  switch (window) {
    case "afternoon":
      return "Para la tarde tengo:";
    case "morning":
      return "Para la mañana tengo:";
    case "weekend":
      return "En fin de semana tengo:";
    case "next_day":
      return "Otro día tengo:";
  }
}

function expandEmptyText(window: ExpandWindow): string {
  switch (window) {
    case "afternoon":
      return "No me quedan horarios en la tarde. ¿Quieres que revise otro día?";
    case "morning":
      return "No me quedan horarios en la mañana. ¿Quieres que revise otro día?";
    case "weekend":
      return "No me quedan horarios en fin de semana. ¿Quieres que revise otro día?";
    case "next_day":
      return "No me quedan más días disponibles por ahora. ¿Quieres que revise otra semana?";
  }
}

export async function offerSlots(input: {
  organizationId: string;
  conversationId: string;
  intro?: string;
  day?: string;
  /** Ampliación explícita (otro día / más tarde / tarde / mañana / fin de semana). */
  expand?: ExpandWindow;
  /** IA-3: índice de ventana ya avanzado por el pipeline (0 = la primera). */
  cursor?: number;
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

  // Se conserva TODA la disponibilidad internamente (catálogo reservable) y se
  // limita SOLO lo que se muestra al cliente.
  await replaceOffers(
    input.organizationId,
    input.conversationId,
    catalog.map((slot) => ({ startUtc: slot.startUtc, label: slot.label }))
  );

  // Ampliación solicitada explícitamente: se muestra el siguiente conjunto
  // relevante, nunca la agenda completa.
  if (input.expand) {
    const window = windowSlots(
      spread,
      input.expand,
      settings.timezone,
      input.cursor ?? 0
    );
    if (window.length === 0) {
      return { ok: false, text: expandEmptyText(input.expand) };
    }
    const list = formatSlotBlocks(window, settings.timezone, now);
    return {
      ok: true,
      text: `${expandIntro(input.expand)}\n${list}\n¿Cuál te funciona mejor?`,
    };
  }

  if (input.day) {
    if (requestedDayHasAvailability) {
      const list = formatSlotBlocks(
        dayShown.slice(0, COMPACT_PRESENTATION.specificDaySlots),
        settings.timezone,
        now
      );
      const intro = safeOfferIntro(input.intro) || "Tengo estos horarios disponibles:";
      return { ok: true, text: `${intro}\n${list}` };
    }

    const list = formatSlotBlocks(
      firstDaySlots(spread, COMPACT_PRESENTATION.altDaySlots),
      settings.timezone,
      now
    );
    const heading = input.businessFact
      ? input.businessFact.businessOpen
        ? `Sí abrimos ${input.businessFact.dateLabel} de ${formatHoursEs(input.businessFact.businessHours)}, pero ya no tengo horarios disponibles ese día.`
        : `${capitalize(input.businessFact.dateLabel)} estamos cerrados.`
      : "Ese día no tengo horarios disponibles.";
    return {
      ok: true,
      text: `${heading} Estas son mis próximas opciones:\n${list}\n¿Te funciona alguno?`,
    };
  }

  const list = formatSlotBlocks(
    firstDaySlots(spread, COMPACT_PRESENTATION.noDateSlots),
    settings.timezone,
    now
  );
  const intro = safeOfferIntro(input.intro) || "Tengo estos horarios disponibles:";
  return { ok: true, text: `${intro}\n${list}\n¿Cuál te funciona mejor?` };
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

  let displayedSlots = 0;
  const blocks = [...byDay.values()].map((slots) => {
    const shown = slots.slice(0, COMPACT_PRESENTATION.rangePerDaySlots);
    displayedSlots += shown.length;
    const title = capitalize(dayLabelInTz(slots[0]!.startUtc, settings.timezone, now));
    const times = shown
      .map((slot) => `• ${timeInTz(slot.startUtc, settings.timezone)}`)
      .join("\n");
    return `${title}\n${times}`;
  });

  const totalAvailableDays = byDay.size;
  const totalAvailableSlots = all.length;
  const pagination: SchedulePagination = {
    totalAvailableSlots,
    displayedSlots,
    totalAvailableDays,
    displayedDays: totalAvailableDays,
    remainingSlots: totalAvailableSlots - displayedSlots,
    remainingDays: 0,
    truncated: displayedSlots < totalAvailableSlots,
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
  const settings = await getSettings(input.organizationId);
  const now = new Date();
  const all = await computeAvailability(input.organizationId, { settings, now });
  if (all.length === 0) {
    return {
      ok: false,
      text: "Por ahora no me quedan horarios libres. Déjame confirmarlo con el equipo y te aviso.",
    };
  }
  const spread = enrichAll(all, settings.timezone, now);

  // Igual que la oferta sin fecha: 1 día y pocos horarios. El catálogo completo
  // queda persistido internamente para poder ampliar si el cliente lo pide.
  await replaceOffers(
    input.organizationId,
    input.conversationId,
    spread.map((slot) => ({ startUtc: slot.startUtc, label: slot.label }))
  );

  const list = formatSlotBlocks(
    firstDaySlots(spread, COMPACT_PRESENTATION.noDateSlots),
    settings.timezone,
    now
  );
  return {
    ok: true,
    text: `Esta es la disponibilidad que tengo:\n${list}\n¿Cuál te funciona mejor?`,
  };
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
  serviceId?: string;
  professionalId?: string;
}): Promise<AgendaTurn> {
  try {
    const result = await createSessionBooking({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      startUtc: input.startUtc,
      serviceId: input.serviceId,
      professionalId: input.professionalId,
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
