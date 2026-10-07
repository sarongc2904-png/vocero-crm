import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { QuoteError } from "@/server/quotes/service";

/**
 * Enlaces públicos /p/[token].
 *
 * - El token son 32 bytes aleatorios (256 bits) en base64url: 43 caracteres.
 * - En la base vive SOLO su SHA-256; el token en claro se devuelve UNA vez, al
 *   emitirlo, y nunca más se puede volver a leer.
 * - Expira con la vigencia de la cotización y se puede revocar. Emitir uno
 *   nuevo revoca los anteriores de esa cotización.
 */

export const QUOTE_TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function generateQuoteToken(): string {
  return randomBytes(QUOTE_TOKEN_BYTES).toString("base64url");
}

export function hashQuoteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Descarta sin tocar la base lo que ni siquiera tiene forma de token. */
export function isWellFormedQuoteToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export type IssuedQuoteLink = {
  /** En claro, solo en esta respuesta. */
  token: string;
  expiresAt: Date;
};

/**
 * Emite (o reemite) el enlace de una cotización del negocio. Si estaba en
 * `borrador`, pasa a `enviada`: publicar el enlace ES entregarla al cliente.
 * Solo un usuario del CRM con sesión llega aquí; el bot no puede publicar.
 */
export async function issueQuoteLink(input: {
  organizationId: string;
  quoteId: string;
  now?: Date;
}): Promise<IssuedQuoteLink> {
  const { organizationId, quoteId } = input;
  if (!organizationId) throw new Error("issueQuoteLink(): organizationId vacío");
  const now = input.now ?? new Date();
  const token = generateQuoteToken();

  const expiresAt = await getDb().transaction(async (tx) => {
    const rows = await tx
      .select({ status: schema.quote.status, validUntil: schema.quote.validUntil })
      .from(schema.quote)
      .where(scoped(schema.quote.organizationId, organizationId, eq(schema.quote.id, quoteId)))
      .for("update")
      .limit(1);
    const quote = rows[0];
    if (!quote) throw new QuoteError("not_found", "Cotización no encontrada");
    if (quote.status !== "borrador" && quote.status !== "enviada") {
      throw new QuoteError("invalid", `La cotización ya está ${quote.status}; no se puede volver a compartir`);
    }
    if (quote.validUntil.getTime() <= now.getTime()) {
      throw new QuoteError("invalid", "La vigencia de la cotización ya terminó");
    }

    await tx
      .update(schema.quoteLink)
      .set({ revokedAt: now })
      .where(
        scoped(
          schema.quoteLink.organizationId,
          organizationId,
          eq(schema.quoteLink.quoteId, quoteId),
          isNull(schema.quoteLink.revokedAt)
        )
      );
    await tx.insert(schema.quoteLink).values({
      id: newId("quoteLink"),
      organizationId,
      quoteId,
      tokenHash: hashQuoteToken(token),
      expiresAt: quote.validUntil,
      createdAt: now,
    });
    if (quote.status === "borrador") {
      await tx
        .update(schema.quote)
        .set({ status: "enviada", sentAt: now, updatedAt: now })
        .where(
          scoped(
            schema.quote.organizationId,
            organizationId,
            and(eq(schema.quote.id, quoteId), eq(schema.quote.status, "borrador"))
          )
        );
    }
    return quote.validUntil;
  });

  return { token, expiresAt };
}

/** Revoca todos los enlaces vivos de una cotización del negocio. */
export async function revokeQuoteLinks(input: {
  organizationId: string;
  quoteId: string;
  now?: Date;
}): Promise<{ revoked: number }> {
  const { organizationId, quoteId } = input;
  if (!organizationId) throw new Error("revokeQuoteLinks(): organizationId vacío");
  const db = getDb();
  const owned = await db
    .select({ id: schema.quote.id })
    .from(schema.quote)
    .where(scoped(schema.quote.organizationId, organizationId, eq(schema.quote.id, quoteId)))
    .limit(1);
  if (!owned[0]) throw new QuoteError("not_found", "Cotización no encontrada");
  const revoked = await db
    .update(schema.quoteLink)
    .set({ revokedAt: input.now ?? new Date() })
    .where(
      scoped(
        schema.quoteLink.organizationId,
        organizationId,
        eq(schema.quoteLink.quoteId, quoteId),
        isNull(schema.quoteLink.revokedAt)
      )
    )
    .returning({ id: schema.quoteLink.id });
  return { revoked: revoked.length };
}
