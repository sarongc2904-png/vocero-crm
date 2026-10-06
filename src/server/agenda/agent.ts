import { computeAvailability, type AvailableSlot } from "@/server/agenda/availability";
import { getSettings } from "@/server/agenda/settings";
import { spreadByDay, type SpreadSlot } from "@/server/agenda/spread";
import { replaceOffers } from "@/server/agenda/offers";
import { BookingError, createSessionBooking } from "@/server/agenda/service";
import { googleAddEventUrl } from "@/lib/calendar-link";
import {
  dateLabelInTz,
  dayIsoInTz,
  dayLabelInTz,
  timeInTz,
  weekdayKeyOf,
} from "@/lib/time/slots";
import { capitalize, formatHoursEs } from "@/server/agenda/schedule-intent";
import { type ExpandWindow } from "@/server/agenda/expand";
import {
  OTHER_TIME_INVITE,
  daypartOf,
  formatDayPresentation,
  offerClosing,
  presentBlock,
  presentFullDay,
  presentationSlots,
  timeMinutes,
  type DayPresentation,
} from "@/server/agenda/presentation";

const DAY_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 015 — Política de presentación compacta de disponibilidad en el chat.
 *
 * La herramienta conserva TODA la disponibilidad internamente (se persiste en
 * `offered_slot` para reservar/reprogramar con alternativas legítimas); lo que
 * se limita es SOLO lo que se muestra al cliente. Sin fecha → 1 día; un día
 * pedido → ese día; un día lleno → el día siguiente. Cada día se presenta en
 * mañana y tarde repartidas (ver `presentation.ts`). Ampliar más solo ante una
 * petición explícita (otro día / más tarde / tarde / mañana / fin de semana).
 *
 * Los topes por día de la oferta de un día viven en `presentation.ts`; aquí
 * queda el tope por día de un rango explícito.
 */
export const COMPACT_PRESENTATION = {
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

/** Todos los horarios de un día del catálogo. */
function slotsOfDay(slots: SpreadSlot[], day: string): SpreadSlot[] {
  return slots.filter((s) => s.dayIso === day);
}

type ExpandResult = { notice?: string; presentation: DayPresentation };

/**
 * Ventana de ampliación sobre el día que se está mostrando (`referenceDay`).
 *
 * - "por la mañana" / "por la tarde": ese bloque del día mostrado, repartido.
 *   Si ese día ya no tiene el bloque, se avisa y se usa el siguiente que sí.
 * - "más tarde": horarios POSTERIORES a `afterTime` en el día mostrado. Si ya
 *   no hay, se avisa y se presenta el día siguiente completo.
 * - "otro día": el día disponible siguiente al mostrado.
 *
 * Sin día de referencia (primer turno de agenda) se conserva el CURSOR de
 * IA-3: la (cursor)-ésima jornada que cumple el criterio.
 */
function expandWindow(
  slots: SpreadSlot[],
  window: ExpandWindow,
  timezone: string,
  cursor: number,
  referenceDay?: string,
  afterTime?: string
): ExpandResult | null {
  const days = distinctDays(slots);
  const inDaypart = (slot: SpreadSlot) =>
    window === "afternoon" || window === "morning"
      ? daypartOf(slot.time) === window
      : true;
  const isWeekendDay = (day: string) => {
    const weekday = weekdayKeyOf(day, timezone);
    return weekday === "sat" || weekday === "sun";
  };
  const dayName = (day: string) => dateLabelInTz(day, timezone);

  if (window === "next_day") {
    // El día 0 es el de la oferta base; el cursor empieza en el siguiente.
    const target = referenceDay
      ? days.find((day) => day > referenceDay)
      : days[1 + cursor];
    if (!target) return null;
    return { presentation: presentFullDay(slotsOfDay(slots, target)) };
  }

  if (window === "weekend") {
    const target = days.filter(isWeekendDay)[cursor];
    if (!target) return null;
    return { presentation: presentFullDay(slotsOfDay(slots, target)) };
  }

  if (window === "later") {
    const day = referenceDay ?? days[0];
    if (!day) return null;
    // Sin horarios mostrados ese día, "más tarde" es la parte tarde del día.
    const later = slotsOfDay(slots, day).filter((s) =>
      afterTime ? timeMinutes(s.time) > timeMinutes(afterTime) : daypartOf(s.time) === "afternoon"
    );
    if (later.length > 0) return { presentation: presentBlock(later) };
    const next = days.find((d) => d > day);
    if (!next) return null;
    return {
      notice: `Para el ${dayName(day)} ya no hay horarios más tarde.`,
      presentation: presentFullDay(slotsOfDay(slots, next)),
    };
  }

  // morning / afternoon
  const matchingDays = days.filter((day) => slotsOfDay(slots, day).some(inDaypart));
  const target = referenceDay
    ? matchingDays.find((day) => day >= referenceDay)
    : matchingDays[cursor];
  if (!target) return null;
  const notice =
    referenceDay && target !== referenceDay
      ? `Para el ${dayName(referenceDay)} ya no hay horarios ${
          window === "afternoon" ? "por la tarde" : "por la mañana"
        }.`
      : undefined;
  return {
    notice,
    presentation: presentBlock(slotsOfDay(slots, target).filter(inDaypart)),
  };
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
    case "later":
      return "Más tarde tengo:";
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
    case "later":
      return "No me quedan horarios más tarde. ¿Quieres que revise otro día?";
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
  /** Día (YYYY-MM-DD) que el cliente está viendo: ancla de las ampliaciones. */
  referenceDay?: string;
  /** Última hora mostrada ese día ("13:30"): ancla de "más tarde". */
  afterTime?: string;
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
    const result = expandWindow(
      spread,
      input.expand,
      settings.timezone,
      input.cursor ?? 0,
      input.referenceDay,
      input.afterTime
    );
    if (!result || presentationSlots(result.presentation).length === 0) {
      return { ok: false, text: expandEmptyText(input.expand) };
    }
    const list = formatDayPresentation(result.presentation, settings.timezone, now);
    return {
      ok: true,
      text: [
        result.notice,
        expandIntro(input.expand),
        list,
        offerClosing(result.presentation),
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (input.day) {
    if (requestedDayHasAvailability) {
      const presentation = presentFullDay(dayShown);
      const list = formatDayPresentation(presentation, settings.timezone, now);
      const intro = safeOfferIntro(input.intro) || "Tengo estos horarios disponibles:";
      return {
        ok: true,
        text: [intro, list, presentation.truncated ? OTHER_TIME_INVITE : undefined]
          .filter(Boolean)
          .join("\n"),
      };
    }

    const presentation = firstDayPresentation(spread);
    const list = formatDayPresentation(presentation, settings.timezone, now);
    const heading = input.businessFact
      ? input.businessFact.businessOpen
        ? `Sí abrimos ${input.businessFact.dateLabel} de ${formatHoursEs(input.businessFact.businessHours)}, pero ya no tengo horarios disponibles ese día.`
        : `${capitalize(input.businessFact.dateLabel)} estamos cerrados.`
      : "Ese día no tengo horarios disponibles.";
    return {
      ok: true,
      text: `${heading} Estas son mis próximas opciones:\n${list}\n¿Te funciona alguno?${
        presentation.truncated ? ` ${OTHER_TIME_INVITE}` : ""
      }`,
    };
  }

  const presentation = firstDayPresentation(spread);
  const list = formatDayPresentation(presentation, settings.timezone, now);
  const intro = safeOfferIntro(input.intro) || "Tengo estos horarios disponibles:";
  return { ok: true, text: `${intro}\n${list}\n${offerClosing(presentation)}` };
}

/** El primer día disponible, presentado en mañana y tarde. */
function firstDayPresentation(slots: SpreadSlot[]): DayPresentation {
  const firstDay = slots[0]?.dayIso;
  return presentFullDay(firstDay ? slotsOfDay(slots, firstDay) : []);
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

  // Igual que la oferta sin fecha: el primer día, en mañana y tarde. El
  // catálogo completo queda persistido para poder ampliar o resolver una hora.
  await replaceOffers(
    input.organizationId,
    input.conversationId,
    spread.map((slot) => ({ startUtc: slot.startUtc, label: slot.label }))
  );

  const presentation = firstDayPresentation(spread);
  const list = formatDayPresentation(presentation, settings.timezone, now);
  return {
    ok: true,
    text: `Esta es la disponibilidad que tengo:\n${list}\n${offerClosing(presentation)}`,
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
