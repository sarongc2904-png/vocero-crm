import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { dayLabelInTz, timeInTz } from "@/lib/time/slots";

/**
 * 015 — Memoria de lo ofrecido a una conversación (requisito INNEGOCIABLE).
 *
 * Sin fila aquí no hay reserva: es lo que impide que un modelo alucine un
 * horario que nunca se le ofreció al cliente. La oferta se reemplaza completa
 * en cada ronda (la vigente es siempre la última) y se limpia al reservar.
 */

export type OfferedSlot = {
  startUtc: string;
  label: string;
  serviceId?: string | null;
  professionalId?: string | null;
};

/**
 * Revalida una oferta persistida contra el reloj de ESTE turno.
 *
 * `label` puede haberse guardado cuando el slot era "hoy". Nunca se reutiliza
 * ese texto relativo: se vuelve a renderizar con la zona del tenant y el reloj
 * recibido. Así un proceso longevo o una conversación retomada días después
 * no puede seguir diciendo "hoy jueves 17" el sábado 19.
 */
export function currentOffers(
  offers: OfferedSlot[],
  opts: { now: Date; minNoticeHours: number; timezone: string }
): OfferedSlot[] {
  const threshold = opts.now.getTime() + opts.minNoticeHours * 3_600_000;
  return offers
    .filter((offer) => {
      const start = Date.parse(offer.startUtc);
      return !Number.isNaN(start) && start > threshold;
    })
    .map((offer) => ({
      ...offer,
      label: `${dayLabelInTz(offer.startUtc, opts.timezone, opts.now)} a las ${timeInTz(
        offer.startUtc,
        opts.timezone
      )}`,
    }));
}

/** Reemplaza TODA la oferta de la conversación, en una transacción. */
export async function replaceOffers(
  organizationId: string,
  conversationId: string,
  slots: OfferedSlot[]
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.offeredSlot)
      .where(
        scoped(
          schema.offeredSlot.organizationId,
          organizationId,
          eq(schema.offeredSlot.conversationId, conversationId)
        )
      );
    if (slots.length === 0) return;
    await tx.insert(schema.offeredSlot).values(
      slots.map((s) => ({
        id: newId("offeredSlot"),
        organizationId,
        conversationId,
        startUtc: new Date(s.startUtc),
        label: s.label,
        serviceId: s.serviceId ?? null,
        professionalId: s.professionalId ?? null,
      }))
    );
  });
}

export async function getOffers(
  organizationId: string,
  conversationId: string
): Promise<OfferedSlot[]> {
  const db = getDb();
  const rows = await db
    .select({
      startUtc: schema.offeredSlot.startUtc,
      label: schema.offeredSlot.label,
      serviceId: schema.offeredSlot.serviceId,
      professionalId: schema.offeredSlot.professionalId,
    })
    .from(schema.offeredSlot)
    .where(
      scoped(
        schema.offeredSlot.organizationId,
        organizationId,
        eq(schema.offeredSlot.conversationId, conversationId)
      )
    )
    .orderBy(asc(schema.offeredSlot.startUtc));

  return rows.map((r) => ({
    startUtc: r.startUtc.toISOString(),
    label: r.label,
    serviceId: r.serviceId,
    professionalId: r.professionalId,
  }));
}

export async function clearOffers(
  organizationId: string,
  conversationId: string
): Promise<void> {
  const db = getDb();
  await db
    .delete(schema.offeredSlot)
    .where(
      scoped(
        schema.offeredSlot.organizationId,
        organizationId,
        eq(schema.offeredSlot.conversationId, conversationId)
      )
    );
}

/**
 * ¿El instante pedido está entre los ofrecidos? Comparación por **epoch
 * exacto**: nada de tolerancias ni de comparar texto. Un ISO con otro offset
 * pero el mismo instante SÍ vale; un minuto de diferencia NO.
 *
 * La tolerancia sería la puerta por donde entra la alucinación: un modelo
 * inventa "el martes a las 10" con facilidad, y comparar exacto convierte eso
 * en un rechazo con la lista de lo que sí se ofreció.
 */
export function findOffered(
  offers: OfferedSlot[],
  whenISO: string,
  context?: { serviceId?: string | null; professionalId?: string | null }
): OfferedSlot | null {
  const target = Date.parse(whenISO);
  if (Number.isNaN(target)) return null;
  return (
    offers.find(
      (offer) =>
        Date.parse(offer.startUtc) === target &&
        (context?.serviceId === undefined || offer.serviceId === context.serviceId) &&
        (context?.professionalId === undefined ||
          offer.professionalId === context.professionalId)
    ) ?? null
  );
}

/** Igualdad de instante, expuesta para tests. */
export function sameInstant(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return !Number.isNaN(x) && !Number.isNaN(y) && x === y;
}

/**
 * Encabezado del bloque de huecos que ve el modelo.
 *
 * Es una constante y no una cadena suelta porque hay DOS lados que dependen de
 * ella: quien la escribe (el turno del agente) y quien la lee (el mock de IA
 * del self-test). Con dos copias, el día que cambie la frase el guion pasaría
 * a verde sin ejercitar nada.
 */
export const CABECERA_HUECOS =
  "Horarios vigentes de esta conversación. Para book_slot usa el startUtc " +
  "EXACTO de la columna derecha, copiado tal cual:";

/**
 * Los huecos vigentes, en la forma en que el modelo puede usarlos.
 *
 * `book_slot` exige el `startUtc` y `findOffered` compara por epoch, sin
 * tolerancia. Pero al modelo solo le llegan el prompt y el historial de TEXTO,
 * donde están las etiquetas que leyó el cliente —«lun 7 sep, 11:00»— sin año,
 * sin zona y sin la fecha de hoy. Con eso, acertar el instante era cuestión de
 * suerte: el rechazo caía siempre en `slot_not_offered`, cuyo texto es fijo, y
 * la conversación se quedaba en bucle repitiendo la lista.
 *
 * Devuelve `null` sin oferta vigente, para que el modelo siga obligado a
 * ofrecer antes de reservar.
 *
 * Reportado por @Diony7004 en #50, con el diagnóstico ya hecho.
 */
export function mapaDeHuecosParaModelo(ofertas: OfferedSlot[]): string | null {
  if (ofertas.length === 0) return null;
  return [
    CABECERA_HUECOS,
    ...ofertas.map((o) => `- "${o.label}" → ${o.startUtc}`),
  ].join("\n");
}
