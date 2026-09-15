import { computeAvailability, type AvailableSlot } from "@/server/agenda/availability";
import { getSettings } from "@/server/agenda/settings";
import { spreadByDay } from "@/server/agenda/spread";
import { replaceOffers } from "@/server/agenda/offers";
import { BookingError, createSessionBooking } from "@/server/agenda/service";
import { googleAddEventUrl } from "@/lib/calendar-link";
import { dateLabelInTz, dayIsoInTz, dayLabelInTz, timeInTz } from "@/lib/time/slots";
import { capitalize, formatHoursEs } from "@/server/agenda/schedule-intent";

const DAY_ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Cuántos huecos por día como máximo en una respuesta de rango/general (WhatsApp: nada de decenas de líneas). */
const RANGE_PER_DAY = 4;
/** Tope total de huecos que se registran como oferta reservable en un rango/general. */
const RANGE_TOTAL = 24;

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
  /**
   * Fase 1 — bug de paginación en rangos: `offerRange`/`offerGeneralAvailability`
   * la exponen para que un consumidor (o un test) sepa exactamente qué se
   * cortó, sin tener que parsear el texto.
   */
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
  /**
   * Fase 1 (fix domingo) — hecho de horario ya resuelto por el backend para
   * `day` (ver `server/agenda/schedule-intent.ts`). Sin esto, "ese día no
   * tiene cupo" sonaba igual tanto si el negocio estaba CERRADO ese día como
   * si estaba abierto pero ya sin horarios — dos situaciones distintas que el
   * cliente necesita distinguir (Caso 1 vs Caso 3 del reporte).
   */
  businessFact?: { businessOpen: boolean; businessHours: string; dateLabel: string };
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
    // Caso 1 (cerrado) vs Caso 3 (abierto pero sin cupo): sin `businessFact`
    // no hay cómo distinguirlos, así que se usa el genérico de antes; con él,
    // el cliente sabe si el negocio no trabaja ese día o si sí trabaja y
    // simplemente ya no hay horarios.
    const encabezado = input.businessFact
      ? input.businessFact.businessOpen
        ? `Sí abrimos ${input.businessFact.dateLabel} de ${formatHoursEs(input.businessFact.businessHours)}, pero ya no tengo horarios disponibles ese día.`
        : `${capitalize(input.businessFact.dateLabel)} estamos cerrados.`
      : "Ese día no tengo horarios disponibles.";
    return {
      ok: true,
      text: `${encabezado} Estas son mis próximas opciones:\n${lista}`,
    };
  }

  const shown = spread.slice(0, SHOWN);
  const lista = shown.map((s) => `• ${s.dayLabel} a las ${s.time}`).join("\n");
  const intro = input.intro?.trim() || "Tengo estos horarios disponibles:";
  return { ok: true, text: `${intro}\n${lista}` };
}

/**
 * Fase 1 — bug de rangos ("de lunes a domingo" devolvía solo lunes) y su
 * segunda vuelta (el bug de paginación: con un rango de 7 días abiertos, el
 * tope total coincidía justo con 6 días completos y el 7º —domingo— quedaba
 * fuera SIN AVISO).
 *
 * Causa raíz original: la selección usaba `spread.slice(0, SHOWN)` sobre un
 * catálogo ya limitado por `perDay` del PRIMER día — la aritmética
 * garantizaba que los primeros elementos fueran siempre del día más próximo.
 * Causa raíz de la segunda vuelta: repartir "hasta `RANGE_PER_DAY` por día,
 * en orden, hasta agotar `RANGE_TOTAL`" sigue pudiendo agotar el tope ANTES
 * de llegar al último día si los días anteriores tienen cupo de sobra — el
 * primer día en desaparecer nunca es el primero del rango, es el que quede
 * fuera del presupuesto, pero el efecto es el mismo: un día con disponibilidad
 * real se vuelve invisible.
 *
 * Algoritmo (dos pasadas, nunca al revés):
 *  1) UN slot por cada día con cupo, mientras alcance el presupuesto — esto
 *     es lo que garantiza que ningún día desaparezca solo por venir "tarde"
 *     en la lista.
 *  2) Con lo que sobre del presupuesto, completar cada día ya representado
 *     hasta `RANGE_PER_DAY`.
 *  3) Lo que no alcanzó a mostrarse (slots sueltos dentro de un día ya
 *     mostrado, o días enteros que ni con 1 slot cupieron) se cuenta y se
 *     anuncia explícitamente — nunca se omite en silencio.
 */
async function offerGrouped(input: {
  organizationId: string;
  conversationId: string;
  fromISO?: string;
  toISO?: string;
  vacioTexto: string;
  encabezado: string;
}): Promise<AgendaTurn> {
  const settings = await getSettings(input.organizationId);
  const now = new Date();
  const all = await computeAvailability(input.organizationId, {
    settings,
    now,
    fromISO: input.fromISO,
    toISO: input.toISO,
  });
  if (all.length === 0) {
    return { ok: false, text: input.vacioTexto };
  }

  // Todo lo disponible, agrupado por día real — `all` ya viene ordenado
  // ascendente (computeAvailability), así que el orden de inserción del Map
  // ya es cronológico.
  const porDiaTodos = new Map<string, AvailableSlot[]>();
  for (const s of all) {
    const d = dayIsoInTz(new Date(s.startUtc), settings.timezone);
    const bucket = porDiaTodos.get(d);
    if (bucket) bucket.push(s);
    else porDiaTodos.set(d, [s]);
  }
  const diasOrdenados = [...porDiaTodos.keys()];
  const totalAvailableDays = diasOrdenados.length;
  const totalAvailableSlots = all.length;

  // Pasada 1: al menos un slot por cada día, mientras alcance.
  const mostrar = new Map<string, AvailableSlot[]>();
  let presupuesto = RANGE_TOTAL;
  for (const dia of diasOrdenados) {
    if (presupuesto <= 0) break;
    mostrar.set(dia, [porDiaTodos.get(dia)![0]!]);
    presupuesto -= 1;
  }
  // Pasada 2: completar hasta RANGE_PER_DAY por día, en el mismo orden,
  // mientras quede presupuesto.
  for (const dia of mostrar.keys()) {
    if (presupuesto <= 0) break;
    const todos = porDiaTodos.get(dia)!;
    const actual = mostrar.get(dia)!;
    while (actual.length < RANGE_PER_DAY && actual.length < todos.length && presupuesto > 0) {
      actual.push(todos[actual.length]!);
      presupuesto -= 1;
    }
  }

  const displayedDays = mostrar.size;
  const displayedSlots = [...mostrar.values()].reduce((n, a) => n + a.length, 0);
  const remainingDays = totalAvailableDays - displayedDays;
  const remainingSlots = totalAvailableSlots - displayedSlots;
  const pagination: SchedulePagination = {
    totalAvailableSlots,
    displayedSlots,
    totalAvailableDays,
    displayedDays,
    remainingSlots,
    remainingDays,
    truncated: remainingDays > 0 || remainingSlots > 0,
  };

  await replaceOffers(
    input.organizationId,
    input.conversationId,
    [...mostrar.values()].flat().map((s) => ({ startUtc: s.startUtc, label: s.label }))
  );

  const bloques = [...mostrar.entries()].map(([dia, slots]) => {
    const titulo = capitalize(dayLabelInTz(slots[0]!.startUtc, settings.timezone, now));
    const horas = slots.map((s) => `• ${timeInTz(s.startUtc, settings.timezone)}`).join("\n");
    const quedanMasEseDia = porDiaTodos.get(dia)!.length > slots.length;
    const pie = quedanMasEseDia ? "\n(tengo más horarios ese día si quieres verlos)" : "";
    return `${titulo}\n${horas}${pie}`;
  });

  // Nunca un corte silencioso: si quedaron días ENTEROS sin representar, se
  // nombran explícitamente (con fecha real, no un "hay más" genérico); si
  // los días ya están todos pero sobran slots sueltos, un aviso más corto.
  let cola = "";
  if (remainingDays > 0) {
    const diasOmitidos = diasOrdenados.filter((d) => !mostrar.has(d));
    const etiquetas = diasOmitidos.map((d) => dateLabelInTz(d, settings.timezone));
    const listado =
      etiquetas.length === 1
        ? etiquetas[0]!
        : `${etiquetas.slice(0, -1).join(", ")} y ${etiquetas[etiquetas.length - 1]}`;
    cola = `\n\nTambién tengo disponibilidad ${listado}. ¿Quieres que te muestre esos horarios?`;
  } else if (remainingSlots > 0) {
    cola = "\n\nTengo más horarios disponibles en algunos de estos días.";
  }

  return {
    ok: true,
    text: `${input.encabezado}\n\n${bloques.join("\n\n")}${cola}`,
    pagination,
  };
}

/**
 * Rango explícito ("de lunes a domingo", "esta semana"): consulta TODO el
 * rango y reparte la exhibición entre los días que sí tienen cupo.
 */
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
    vacioTexto:
      "No tengo horarios disponibles en ese rango de fechas. ¿Te gustaría que revise otras fechas?",
    encabezado: "Estos son los horarios disponibles:",
  });
}

/**
 * "Dame todos los horarios disponibles", sin día ni rango: antes esto
 * obligaba al modelo a preguntar "¿qué día?" porque no existía ninguna forma
 * de mostrar disponibilidad general — ahora sí la hay, agrupada por día
 * dentro de la ventana normal de `maxDaysAhead`.
 */
export async function offerGeneralAvailability(input: {
  organizationId: string;
  conversationId: string;
}): Promise<AgendaTurn> {
  return offerGrouped({
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    vacioTexto:
      "Por ahora no me quedan horarios libres. Déjame confirmarlo con el equipo y te aviso.",
    encabezado: "Esta es la disponibilidad que tengo:",
  });
}

/** "Cuál es la próxima cita disponible" — el hueco más próximo, sin más. */
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
  const first = all[0]!; // computeAvailability ya viene ordenado ascendente
  await replaceOffers(input.organizationId, input.conversationId, [
    { startUtc: first.startUtc, label: first.label },
  ]);
  return { ok: true, text: `La próxima cita disponible es ${first.label}. ¿Te la agendo?` };
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
