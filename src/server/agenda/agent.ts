import { computeAvailability } from "@/server/agenda/availability";
import { getSettings } from "@/server/agenda/settings";
import { spreadByDay, type SpreadSlot } from "@/server/agenda/spread";
import { replaceOffers } from "@/server/agenda/offers";
import { BookingError, createSessionBooking } from "@/server/agenda/service";

const DAY_ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Une dos catálogos de huecos sin repetir instante (por `startUtc`). */
function mergeSlots(a: SpreadSlot[], b: SpreadSlot[]): SpreadSlot[] {
  const seen = new Set<string>();
  const out: SpreadSlot[] = [];
  for (const s of [...a, ...b]) {
    if (seen.has(s.startUtc)) continue;
    seen.add(s.startUtc);
    out.push(s);
  }
  return out;
}

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
  const dayAvailability =
    input.day && DAY_ISO.test(input.day)
      ? await computeAvailability(input.organizationId, {
          settings,
          now,
          fromISO: input.day,
          toISO: input.day,
        })
      : [];
  const dayShown = spreadByDay(dayAvailability, {
    timezone: settings.timezone,
    limit: SHOWN,
    perDay: SHOWN,
    now,
  });

  const catalogo = mergeSlots(spread, dayShown);
  if (catalogo.length === 0) {
    // Agenda llena no es un error: es una respuesta que el cliente entiende.
    return {
      ok: false,
      text:
        input.intro?.trim() ||
        "Por ahora no me quedan horarios libres. Déjame confirmarlo con el equipo y te aviso.",
    };
  }

  // Se REGISTRA todo el catálogo (general + el día pedido), no solo lo que se
  // enseña: si el cliente pide otro día, el agente tiene alternativas
  // legítimas que aceptar.
  await replaceOffers(
    input.organizationId,
    input.conversationId,
    catalogo.map((s) => ({ startUtc: s.startUtc, label: s.label }))
  );

  if (input.day) {
    if (dayShown.length > 0) {
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

export async function bookSlot(input: {
  organizationId: string;
  conversationId: string;
  startUtc: string;
  confirmation?: string;
}): Promise<AgendaTurn> {
  try {
    const result = await createSessionBooking({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      startUtc: input.startUtc,
      source: "ai",
      requireOffer: true,
    });

    const base =
      input.confirmation?.trim() || `¡Listo! Te agendé para ${result.label}.`;
    if (result.meetingLink) {
      return { ok: true, text: `${base}\nEnlace: ${result.meetingLink}` };
    }
    if (result.linkPending) {
      // La cita existe; el enlace no. No se promete lo que no se tiene.
      return {
        ok: true,
        text: `${base}\nEn un momento te comparto el enlace por aquí.`,
      };
    }
    return { ok: true, text: base };
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
