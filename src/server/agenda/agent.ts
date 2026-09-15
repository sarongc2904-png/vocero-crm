import { computeAvailability } from "@/server/agenda/availability";
import { getSettings } from "@/server/agenda/settings";
import { spreadByDay } from "@/server/agenda/spread";
import { replaceOffers } from "@/server/agenda/offers";
import { BookingError, createSessionBooking } from "@/server/agenda/service";
import { googleAddEventUrl } from "@/lib/calendar-link";
import { dayIsoInTz } from "@/lib/time/slots";

const DAY_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 015 — Lo que el agente incluido puede hacer con la agenda.
 *
 * Vive aquí y no en el pipeline para que el pipeline no aprenda de agendas: el
 * turno pide "ofrece" o "reserva" y recibe el texto que hay que mandar.
 *
 * Regla que atraviesa las dos operaciones: el modelo NO redacta horarios. Pide
 * ofrecer, y el motor pega las etiquetas reales. Si el modelo inventa un
 * instante al reservar, el motor lo rechaza y se re-ofrece — nunca se agenda
 * algo que el cliente no eligió.
 */

/** Cuántos huecos se le enseñan al cliente en un mensaje. */
const SHOWN = 3;
/** Cuántos se guardan como reservables: el catálogo es más ancho que el menú. */
const OFFERED = 12;

export type AgendaTurn = {
  /** Lo que hay que enviarle al cliente. */
  text: string;
  /** false ⇒ el motor no pudo; el turno sigue, sin agendar. */
  ok: boolean;
};

export async function offerSlots(input: {
  organizationId: string;
  conversationId: string;
  intro?: string;
  /**
   * Día que el modelo detectó en el mensaje del cliente (YYYY-MM-DD), si
   * mencionó uno. Ver prompts.ts: el modelo lo calcula con la fecha de "hoy"
   * que se le da como ancla.
   */
  day?: string;
}): Promise<AgendaTurn> {
  const settings = await getSettings(input.organizationId);
  const now = new Date();
  const all = await computeAvailability(input.organizationId, {
    settings,
    now,
  });
  const spread = spreadByDay(all, {
    timezone: settings.timezone,
    limit: OFFERED,
    perDay: 3,
    now,
  });

  /**
   * Bug de #agenda-fecha: el cliente pedía "el viernes" y el `reply` del
   * modelo lo decía, pero el motor siempre pegaba el catálogo general (los
   * `OFFERED` más próximos), que casi nunca llega tan lejos — resultado: el
   * texto prometía viernes y la lista traía martes.
   *
   * Se consulta el día pedido APARTE, acotado a esa sola fecha: el catálogo
   * general no tiene por qué alcanzarlo.
   */
  const dayAvailabilityRaw =
    input.day && DAY_ISO.test(input.day)
      ? await computeAvailability(input.organizationId, {
          settings,
          now,
          fromISO: input.day,
          toISO: input.day,
        })
      : [];
  /**
   * Fase 1 — assert(slot.localDate === targetDate): `computeAvailability`
   * acotado a un solo día YA debería devolver solo ese día, pero esto es la
   * última barrera antes de que algo llegue al cliente. Si algún día un bug
   * en el motor de disponibilidad devolviera un slot de otro día, esta línea
   * lo descarta en vez de ofrecerlo como si fuera el pedido.
   */
  const dayAvailability = input.day
    ? dayAvailabilityRaw.filter(
        (s) => dayIsoInTz(new Date(s.startUtc), settings.timezone) === input.day
      )
    : dayAvailabilityRaw;
  const dayShown = spreadByDay(dayAvailability, {
    timezone: settings.timezone,
    limit: SHOWN,
    perDay: SHOWN,
    now,
  });

  const pidioDiaConCupo = Boolean(input.day) && dayShown.length > 0;
  /**
   * Bug #agenda-fecha-2: registrar el catálogo GENERAL (otros días) junto con
   * el del día pedido dejaba ambas fechas como "vigentes" a la vez — el
   * cliente pedía el sábado, y al confirmar el modelo podía copiar por error
   * el `startUtc` de un slot del jueves que seguía en la misma lista.
   *
   * Cuando el día pedido SÍ tiene cupo, lo vigente es SOLO ese día: no hay
   * nada más que el modelo pueda confundir al confirmar. El catálogo general
   * solo entra cuando no hay día pedido, o cuando ese día no tiene nada que
   * ofrecer (ahí sí hacen falta alternativas de otros días).
   */
  const catalogo = pidioDiaConCupo ? dayShown : spread;
  if (catalogo.length === 0) {
    // Agenda llena no es un error: es una respuesta que el cliente entiende.
    return {
      ok: false,
      text:
        input.intro?.trim() ||
        "Por ahora no me quedan horarios libres. Déjame confirmarlo con el equipo y te aviso.",
    };
  }

  // Reemplaza TODA la oferta vigente de la conversación: lo de un turno
  // anterior (quizás de otro día) deja de ser confirmable.
  await replaceOffers(
    input.organizationId,
    input.conversationId,
    catalogo.map((s) => ({ startUtc: s.startUtc, label: s.label }))
  );

  if (input.day) {
    if (pidioDiaConCupo) {
      const lista = dayShown
        .map((s) => `• ${s.dayLabel} a las ${s.time}`)
        .join("\n");
      const intro = input.intro?.trim() || "Tengo estos horarios disponibles:";
      return { ok: true, text: `${intro}\n${lista}` };
    }
    // Ese día no tiene nada: se avisa en vez de fingir que sí (ignorando el
    // `intro` del modelo, que asumía que había — ver docstring de arriba), y
    // se ofrecen alternativas reales.
    const lista = spread
      .slice(0, SHOWN)
      .map((s) => `• ${s.dayLabel} a las ${s.time}`)
      .join("\n");
    return {
      ok: true,
      text: `Ese día no tengo horarios disponibles. Estas son mis próximas opciones:\n${lista}`,
    };
  }

  const shown = spread.slice(0, SHOWN);
  const lista = shown.map((s) => `• ${s.dayLabel} a las ${s.time}`).join("\n");
  const intro = input.intro?.trim() || "Tengo estos horarios disponibles:";
  return { ok: true, text: `${intro}\n${lista}` };
}

/**
 * Fase 1 — ya NO recibe el `reply`/`confirmation` del modelo: se ignoraba a
 * propósito para la fecha/hora (causa raíz del bug de agenda — el LLM no
 * calcula fechas de forma confiable, y confirmar con SU texto podía felicitar
 * al cliente por un día distinto al que de verdad se agendó), así que
 * mantenerlo en la firma era una puerta sin usar. El texto de confirmación lo
 * construye este módulo, siempre desde `result.label` (el booking real).
 */
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

    // SIEMPRE `result.label` (el booking real que quedó en la base) — nunca
    // el texto libre del modelo. Es la corrección directa al bug de
    // producción: el cliente pedía sábado, el `reply` del modelo decía
    // "sábado", y el booking real caía el jueves.
    const base = `¡Listo! Te agendé para ${result.label}.`;

    // Recordatorio para el CLIENTE (no la reunión): un enlace público de
    // Google Calendar que cualquiera puede abrir para guardar SU cita, sin
    // que dependa del conector del negocio ni de credenciales de nadie.
    const recordatorio = googleAddEventUrl({
      title: "Tu cita",
      startUtc: input.startUtc,
      durationMinutes: result.booking.durationMinutes,
    });
    const conRecordatorio = (texto: string) =>
      `${texto}\nAgrega la cita a tu calendario: ${recordatorio}`;

    if (result.meetingLink) {
      return {
        ok: true,
        text: conRecordatorio(`${base}\nEnlace: ${result.meetingLink}`),
      };
    }
    if (result.linkPending) {
      // La cita existe; el enlace de la reunión no. No se promete lo que no
      // se tiene — el recordatorio de calendario no depende de eso.
      return {
        ok: true,
        text: conRecordatorio(`${base}\nEn un momento te comparto el enlace por aquí.`),
      };
    }
    return { ok: true, text: conRecordatorio(base) };
  } catch (err) {
    if (!(err instanceof BookingError)) throw err;

    // Se ocupó o el modelo inventó la hora: en ambos casos se re-ofrece con
    // datos reales en vez de discutir con el cliente.
    if (err.slots.length > 0) {
      const lista = err.slots
        .slice(0, SHOWN)
        .map((s) => `• ${s.label}`)
        .join("\n");
      const disculpa =
        err.code === "slot_taken"
          ? "Se me acaba de ocupar ese horario, ¡perdón!"
          : "Déjame confirmarte los horarios que tengo:";
      return { ok: false, text: `${disculpa}\n${lista}` };
    }
    return {
      ok: false,
      text: "No pude agendarlo en este momento. Lo reviso con el equipo y te confirmo.",
    };
  }
}
