import { and, asc, eq, exists, gt, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import type { QuoteStatus } from "@/lib/db/schema";
import { takeNextQuoteNumber } from "@/server/quotes/numbering";
import { getQuoteSettings } from "@/server/quotes/settings";
import { getQuote, QuoteError, type QuoteView } from "@/server/quotes/service";
import { computeQuoteTotals } from "@/server/quotes/totals";

/**
 * Transiciones de estado que dispara un OPERADOR del CRM.
 *
 *   borrador ──marcar enviada (enlace vivo + vigente)──▶ enviada
 *   borrador ──(fase WhatsApp: Meta aceptó)───────────▶ enviada
 *   enviada  ──cliente desde /p/[token]───────────────▶ aceptada | rechazada
 *   enviada  ──vence valid_until (al leer)─────────────▶ expirada
 *   borrador | enviada ──cancelar─────────────────────▶ cancelada
 *   cualquiera ≠ borrador ──duplicar──▶ borrador nuevo (y cancela si estaba enviada)
 *
 * Cada transición es UN `UPDATE … WHERE status IN (origen)` dentro del
 * negocio: si dos operadores chocan, solo una escritura encuentra el estado
 * de origen, y la otra recibe `invalid_transition` (409).
 */

export const OPERATOR_TRANSITIONS: Readonly<Record<"markSent" | "cancel", readonly QuoteStatus[]>> = {
  markSent: ["borrador"],
  cancel: ["borrador", "enviada"],
};

async function currentStatus(organizationId: string, quoteId: string): Promise<QuoteStatus | null> {
  const rows = await getDb()
    .select({ status: schema.quote.status })
    .from(schema.quote)
    .where(scoped(schema.quote.organizationId, organizationId, eq(schema.quote.id, quoteId)))
    .limit(1);
  return rows[0]?.status ?? null;
}

async function failTransition(organizationId: string, quoteId: string, why: string): Promise<never> {
  const status = await currentStatus(organizationId, quoteId);
  if (!status) throw new QuoteError("not_found", "Cotización no encontrada");
  throw new QuoteError("invalid_transition", why);
}

/**
 * El operador confirma que compartió el enlace por su cuenta. Exige un enlace
 * VIVO (no revocado, no vencido) y vigencia futura: marcar como enviada una
 * cotización que el cliente no puede abrir sería un estado engañoso.
 */
export async function markQuoteSent(input: {
  organizationId: string;
  quoteId: string;
  userId: string;
  now?: Date;
}): Promise<QuoteView> {
  const { organizationId, quoteId } = input;
  if (!organizationId) throw new Error("markQuoteSent(): organizationId vacío");
  const now = input.now ?? new Date();
  const db = getDb();

  const updated = await db
    .update(schema.quote)
    .set({ status: "enviada", sentAt: now, sentVia: "enlace", sentBy: input.userId, updatedAt: now })
    .where(
      scoped(
        schema.quote.organizationId,
        organizationId,
        eq(schema.quote.id, quoteId),
        inArray(schema.quote.status, [...OPERATOR_TRANSITIONS.markSent]),
        gt(schema.quote.validUntil, now),
        exists(
          db
            .select({ one: sql`1` })
            .from(schema.quoteLink)
            .where(
              and(
                eq(schema.quoteLink.organizationId, organizationId),
                eq(schema.quoteLink.quoteId, quoteId),
                isNull(schema.quoteLink.revokedAt),
                gt(schema.quoteLink.expiresAt, now)
              )
            )
        )
      )
    )
    .returning({ id: schema.quote.id });

  if (!updated[0]) {
    const status = await currentStatus(organizationId, quoteId);
    if (!status) throw new QuoteError("not_found", "Cotización no encontrada");
    if (status !== "borrador") {
      throw new QuoteError("invalid_transition", `La cotización ya está ${status}`);
    }
    throw new QuoteError(
      "invalid_transition",
      "Para marcarla como enviada necesita un enlace vigente y que la cotización no haya vencido"
    );
  }
  return (await getQuote(organizationId, quoteId))!;
}

/** Cancela un borrador o una enviada y revoca sus enlaces (el cliente ve 404). */
export async function cancelQuote(input: {
  organizationId: string;
  quoteId: string;
  now?: Date;
}): Promise<QuoteView> {
  const { organizationId, quoteId } = input;
  if (!organizationId) throw new Error("cancelQuote(): organizationId vacío");
  const now = input.now ?? new Date();

  const done = await getDb().transaction(async (tx) => {
    const updated = await tx
      .update(schema.quote)
      .set({ status: "cancelada", updatedAt: now })
      .where(
        scoped(
          schema.quote.organizationId,
          organizationId,
          eq(schema.quote.id, quoteId),
          inArray(schema.quote.status, [...OPERATOR_TRANSITIONS.cancel])
        )
      )
      .returning({ id: schema.quote.id });
    if (!updated[0]) return false;
    await tx
      .update(schema.quoteLink)
      .set({ revokedAt: now })
      .where(
        scoped(schema.quoteLink.organizationId, organizationId, eq(schema.quoteLink.quoteId, quoteId), isNull(schema.quoteLink.revokedAt))
      );
    return true;
  });
  if (!done) await failTransition(organizationId, quoteId, "Solo se puede cancelar un borrador o una cotización enviada");
  return (await getQuote(organizationId, quoteId))!;
}

/**
 * "Duplicar" para corregir: copia las líneas tal cual se cotizaron a un
 * borrador NUEVO (folio nuevo, vigencia nueva, IVA vigente del negocio) y, si
 * la original estaba `enviada`, la cancela en la misma transacción para que
 * el cliente no acepte la versión vieja. Un borrador se edita, no se duplica.
 */
export async function duplicateQuote(input: {
  organizationId: string;
  quoteId: string;
  userId: string;
  now?: Date;
}): Promise<{ original: QuoteView; copy: QuoteView }> {
  const { organizationId, quoteId } = input;
  if (!organizationId) throw new Error("duplicateQuote(): organizationId vacío");
  const now = input.now ?? new Date();

  const copyId = await getDb().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.quote)
      .where(scoped(schema.quote.organizationId, organizationId, eq(schema.quote.id, quoteId)))
      .for("update")
      .limit(1);
    const original = rows[0];
    if (!original) throw new QuoteError("not_found", "Cotización no encontrada");
    if (original.status === "borrador") {
      throw new QuoteError("invalid_transition", "Un borrador se edita directamente; no hace falta duplicarlo");
    }
    const items = await tx
      .select()
      .from(schema.quoteItem)
      .where(scoped(schema.quoteItem.organizationId, organizationId, eq(schema.quoteItem.quoteId, quoteId)))
      .orderBy(asc(schema.quoteItem.position));

    if (original.status === "enviada") {
      await tx
        .update(schema.quote)
        .set({ status: "cancelada", updatedAt: now })
        .where(
          scoped(schema.quote.organizationId, organizationId, eq(schema.quote.id, quoteId), eq(schema.quote.status, "enviada"))
        );
      await tx
        .update(schema.quoteLink)
        .set({ revokedAt: now })
        .where(
          scoped(schema.quoteLink.organizationId, organizationId, eq(schema.quoteLink.quoteId, quoteId), isNull(schema.quoteLink.revokedAt))
        );
    }

    // Las líneas conservan el precio cotizado; los totales sí se recalculan
    // con el IVA vigente del negocio, que es el que regirá la nueva.
    const settings = await getQuoteSettings(organizationId, tx);
    const totals = computeQuoteTotals({
      lineTotalsCents: items.map((item) => item.lineTotalCents),
      pricesIncludeTax: settings.pricesIncludeTax,
      taxRateBps: settings.taxRateBps,
    });
    const number = await takeNextQuoteNumber(tx, organizationId);
    const id = newId("quote");
    await tx.insert(schema.quote).values({
      id,
      organizationId,
      contactId: original.contactId,
      conversationId: original.conversationId,
      leadId: original.leadId,
      number,
      status: "borrador",
      currency: original.currency,
      pricesIncludeTax: settings.pricesIncludeTax,
      taxRateBps: settings.taxRateBps,
      subtotalCents: totals.subtotalCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
      validUntil: new Date(now.getTime() + settings.defaultValidityDays * 86_400_000),
      notes: original.notes,
      source: "manual",
      isTest: original.isTest,
      createdBy: input.userId,
      duplicatedFromId: original.id,
      createdAt: now,
      updatedAt: now,
    });
    if (items.length > 0) {
      await tx.insert(schema.quoteItem).values(
        items.map((item) => ({
          id: newId("quoteItem"),
          organizationId,
          quoteId: id,
          serviceId: item.serviceId,
          position: item.position,
          description: item.description,
          quantityMilli: item.quantityMilli,
          unitPriceCents: item.unitPriceCents,
          lineTotalCents: item.lineTotalCents,
        }))
      );
    }
    return id;
  });

  return {
    original: (await getQuote(organizationId, quoteId))!,
    copy: (await getQuote(organizationId, copyId))!,
  };
}
