import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { getEnv } from "@/lib/env";
import { describeSendError } from "@/lib/meta/send-errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { countVariables } from "@/lib/templates";
import { publish } from "@/server/events/bus";
import { SendError, sendMediaMessage } from "@/server/inbox/send";
import { isWindowOpen } from "@/server/inbox/window";
import { getCredentialsByOrg } from "@/server/whatsapp/credentials";
import { sendTemplate, TemplateError } from "@/server/whatsapp/templates";
import { generateQuoteToken, replaceQuoteLinkInTx } from "@/server/quotes/links";
import { formatQuoteFolio } from "@/server/quotes/numbering";
import { renderQuotePdf } from "@/server/quotes/pdf";
import { getPublicLogo } from "@/server/quotes/public";
import { getQuote } from "@/server/quotes/service";
import { getQuoteSettings } from "@/server/quotes/settings";

/**
 * Envío de una cotización por WhatsApp, disparado SOLO por un operador del
 * CRM con `quotes.publish`. El bot y el agente no llegan aquí.
 *
 * Flujo (un intento = una fila de `quote_send`):
 *  1. Misma `idempotencyKey` → se devuelve el intento guardado, sin reenviar.
 *  2. Límite por negocio (por minuto y por hora).
 *  3. Transacción: cotización bloqueada; `borrador`, vigente, no Laboratorio;
 *     ventana o plantilla válida; número conectado. Se registra el intento
 *     `pendiente` (índice: uno en curso por cotización) y se emite el enlace.
 *  4. Se habla con Meta FUERA de la transacción.
 *  5. Meta aceptó → intento `enviado` + cotización `enviada` (whatsapp).
 *     Falló     → intento `fallido` + enlace de ese intento REVOCADO; la
 *     cotización sigue en `borrador`.
 *  Un `pendiente` con más de 5 minutos se LEE como `incierto` y lo resuelve
 *  el operador ("Sí llegó" / "No llegó"); nunca se reenvía solo.
 *
 * El token del enlace solo existe en memoria: a Meta va el texto completo y a
 * la base, al hilo y a SSE, la versión enmascarada. Todo texto de error pasa
 * por `redact()` por si Meta repitiera parte de lo enviado.
 */

export const SEND_UNCERTAIN_AFTER_MS = 5 * 60_000;
/** Por NEGOCIO. Un operador manda cotizaciones de una en una; esto frena bucles y abuso. */
export const QUOTE_SEND_LIMITS = {
  perMinute: { windowMs: 60_000, max: 10 },
  perHour: { windowMs: 60 * 60_000, max: 100 },
} as const;

export type SendStatusView = "pendiente" | "enviado" | "fallido" | "incierto";

export type QuoteSendView = {
  id: string;
  status: SendStatusView;
  mode: "documento" | "plantilla" | null;
  errorCode: string | null;
  /** Mensaje para el operador (lista cerrada, sin texto crudo de Meta). */
  errorMessage: string | null;
  resolution: "llego" | "no_llego" | null;
  createdAt: Date;
  completedAt: Date | null;
};

export type QuoteSendErrorCode =
  | "not_found"
  | "invalid_transition"
  | "invalid"
  | "lab"
  | "no_template"
  | "not_whatsapp"
  | "not_connected"
  | "reconnect_required"
  | "in_progress"
  | "uncertain_pending"
  | "rate_limited"
  | "key_conflict";

export class QuoteSendError extends Error {
  constructor(
    readonly code: QuoteSendErrorCode,
    message: string
  ) {
    super(message);
    this.name = "QuoteSendError";
  }
}

export function quoteSendErrorStatus(code: QuoteSendErrorCode): number {
  switch (code) {
    case "not_found":
      return 404;
    case "invalid_transition":
    case "in_progress":
    case "uncertain_pending":
    case "key_conflict":
      return 409;
    case "rate_limited":
      return 429;
    default:
      return 422;
  }
}

/** Mensajes de una lista CERRADA para lo que falló hablando con Meta. */
const META_FAILURE_MESSAGE: Record<string, string> = {
  window_closed: "Pasaron más de 24 h desde el último mensaje del cliente. Usa una plantilla aprobada.",
  not_connected: "No hay un número de WhatsApp conectado.",
  reconnect_required: "El token de WhatsApp expiró: reconecta el número en Configuración.",
  meta_unavailable: "Meta no está disponible en este momento. Intenta en unos minutos.",
  upload_failed: "No se pudo subir el PDF a WhatsApp. Intenta de nuevo.",
  sandbox_violation: "Las conversaciones del Laboratorio no envían mensajes reales.",
  no_llego: "El operador confirmó que el mensaje no llegó.",
};

export function operatorMessageFor(errorCode: string | null): string | null {
  if (!errorCode) return null;
  if (META_FAILURE_MESSAGE[errorCode]) return META_FAILURE_MESSAGE[errorCode]!;
  const meta = /^meta_(\d+)$/.exec(errorCode);
  if (meta) {
    // Solo la traducción de un código CONOCIDO; un código desconocido no
    // trae el texto de Meta (podría repetir lo que se envió).
    const known = describeSendError(Number(meta[1]), null);
    return known.startsWith("Meta rechazó el envío")
      ? `Meta rechazó el envío (código ${meta[1]}). Intenta más tarde.`
      : known;
  }
  return "No se pudo enviar por WhatsApp. Intenta más tarde.";
}

function errorCodeOf(err: unknown): string {
  if (err instanceof SendError) {
    if (err.code === "meta_error" && typeof err.metaCode === "number") return `meta_${err.metaCode}`;
    return err.code;
  }
  if (err instanceof TemplateError) return err.code === "reconnect_required" || err.code === "not_connected" ? err.code : "template_error";
  return "internal";
}

function toView(row: typeof schema.quoteSend.$inferSelect, now: Date): QuoteSendView {
  const uncertain = row.status === "pendiente" && now.getTime() - row.createdAt.getTime() > SEND_UNCERTAIN_AFTER_MS;
  return {
    id: row.id,
    status: uncertain ? "incierto" : row.status,
    mode: row.mode,
    errorCode: row.errorCode,
    errorMessage: row.status === "fallido" ? operatorMessageFor(row.errorCode) : null,
    resolution: row.resolution,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

/** El último intento de envío de una cotización del negocio (para el detalle). */
export async function getLatestQuoteSend(
  organizationId: string,
  quoteId: string,
  now: Date = new Date()
): Promise<QuoteSendView | null> {
  const rows = await getDb()
    .select()
    .from(schema.quoteSend)
    .where(scoped(schema.quoteSend.organizationId, organizationId, eq(schema.quoteSend.quoteId, quoteId)))
    .orderBy(desc(schema.quoteSend.createdAt))
    .limit(1);
  return rows[0] ? toView(rows[0], now) : null;
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = (err as { cause?: { code?: string; constraint_name?: string } }).cause ?? (err as { code?: string; constraint_name?: string });
  return e?.code === "23505" && e?.constraint_name === constraint;
}

async function attemptByKey(organizationId: string, key: string) {
  const rows = await getDb()
    .select()
    .from(schema.quoteSend)
    .where(scoped(schema.quoteSend.organizationId, organizationId, eq(schema.quoteSend.idempotencyKey, key)))
    .limit(1);
  return rows[0] ?? null;
}

/** Enmascara el enlace: lo que se guarda, se registra y se muestra. */
function maskedUrl(folio: string): string {
  return `${appBase()}/p/•••••• (enlace de la cotización ${folio})`;
}

function appBase(): string {
  // SIEMPRE el dominio configurado del CRM; nunca Host/Origin del cliente.
  return getEnv().APP_BASE_URL.replace(/\/+$/, "");
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join("••••••");
  return out;
}

export type SendQuoteInput = {
  organizationId: string;
  quoteId: string;
  userId: string;
  idempotencyKey: string;
  now?: Date;
};

export async function sendQuoteByWhatsApp(input: SendQuoteInput): Promise<QuoteSendView> {
  const { organizationId, quoteId, userId, idempotencyKey } = input;
  if (!organizationId) throw new Error("sendQuoteByWhatsApp(): organizationId vacío");
  const now = input.now ?? new Date();
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
    throw new QuoteSendError("invalid", "Falta una clave de envío válida");
  }

  // 1. Idempotencia: el mismo intento devuelve lo que ya pasó.
  const previous = await attemptByKey(organizationId, idempotencyKey);
  if (previous) {
    if (previous.quoteId !== quoteId) throw new QuoteSendError("key_conflict", "Esa clave de envío ya se usó en otra cotización");
    return toView(previous, now);
  }

  // 2. Límite por negocio.
  const perMinute = checkRateLimit(`quote-send:min:${organizationId}`, QUOTE_SEND_LIMITS.perMinute, now.getTime());
  const perHour = perMinute.allowed
    ? checkRateLimit(`quote-send:hour:${organizationId}`, QUOTE_SEND_LIMITS.perHour, now.getTime())
    : { allowed: false };
  if (!perMinute.allowed || !perHour.allowed) {
    throw new QuoteSendError(
      "rate_limited",
      `Se alcanzó el límite de envíos de cotizaciones (${QUOTE_SEND_LIMITS.perMinute.max} por minuto y ${QUOTE_SEND_LIMITS.perHour.max} por hora). Intenta más tarde.`
    );
  }

  // 3. Validar, registrar el intento y emitir el enlace, todo o nada.
  const token = generateQuoteToken();
  type Prepared = {
    sendId: string;
    linkId: string;
    conversationId: string;
    mode: "documento" | "plantilla";
    templateId: string | null;
    contactName: string;
  };
  let outcome: { existing: typeof schema.quoteSend.$inferSelect } | { prepared: Prepared };
  try {
    outcome = await getDb().transaction(async (tx): Promise<{ existing: typeof schema.quoteSend.$inferSelect } | { prepared: Prepared }> => {
      const quotes = await tx
        .select()
        .from(schema.quote)
        .where(scoped(schema.quote.organizationId, organizationId, eq(schema.quote.id, quoteId)))
        .for("update")
        .limit(1);
      const quote = quotes[0];
      if (!quote) throw new QuoteSendError("not_found", "Cotización no encontrada");
      // Con la cotización ya bloqueada: si otra petición con la MISMA clave
      // llegó primero (doble clic), su intento es el resultado.
      const sameKey = await tx
        .select()
        .from(schema.quoteSend)
        .where(scoped(schema.quoteSend.organizationId, organizationId, eq(schema.quoteSend.idempotencyKey, idempotencyKey)))
        .limit(1);
      if (sameKey[0]) {
        if (sameKey[0].quoteId !== quoteId) throw new QuoteSendError("key_conflict", "Esa clave de envío ya se usó en otra cotización");
        return { existing: sameKey[0] };
      }
      if (quote.status !== "borrador") {
        throw new QuoteSendError("invalid_transition", `La cotización ya está ${quote.status}; solo se envía un borrador`);
      }
      if (quote.validUntil.getTime() <= now.getTime()) {
        throw new QuoteSendError("invalid", "La vigencia de la cotización ya terminó; edítala antes de enviarla");
      }
      if (quote.isTest) throw new QuoteSendError("lab", "Las cotizaciones del Laboratorio no envían mensajes reales");
      if (!quote.conversationId) throw new QuoteSendError("invalid", "La cotización no tiene una conversación a la cual enviarla");

      const conversations = await tx
        .select({ conversation: schema.conversation, contactName: schema.contact.name })
        .from(schema.conversation)
        .innerJoin(
          schema.contact,
          and(eq(schema.contact.id, schema.conversation.contactId), eq(schema.contact.organizationId, schema.conversation.organizationId))
        )
        .where(scoped(schema.conversation.organizationId, organizationId, eq(schema.conversation.id, quote.conversationId)))
        .limit(1);
      const row = conversations[0];
      if (!row) throw new QuoteSendError("not_found", "Conversación no encontrada");
      if (row.conversation.isTest) throw new QuoteSendError("lab", "Las conversaciones del Laboratorio no envían mensajes reales");
      if (row.conversation.channel !== "whatsapp") {
        throw new QuoteSendError("not_whatsapp", "Solo se pueden enviar cotizaciones por WhatsApp");
      }

      // Una sola vez por cotización en curso; un pendiente viejo es incierto.
      const pending = await tx
        .select({ createdAt: schema.quoteSend.createdAt })
        .from(schema.quoteSend)
        .where(
          scoped(schema.quoteSend.organizationId, organizationId, eq(schema.quoteSend.quoteId, quoteId), eq(schema.quoteSend.status, "pendiente"))
        )
        .limit(1);
      if (pending[0]) {
        if (now.getTime() - pending[0].createdAt.getTime() > SEND_UNCERTAIN_AFTER_MS) {
          throw new QuoteSendError(
            "uncertain_pending",
            "Un envío anterior quedó sin confirmar. Revisa la conversación y marca si llegó o no antes de reenviar."
          );
        }
        throw new QuoteSendError("in_progress", "Ya hay un envío de esta cotización en curso");
      }

      let mode: "documento" | "plantilla" = "documento";
      let templateId: string | null = null;
      if (!isWindowOpen(row.conversation.lastInboundAt, now)) {
        mode = "plantilla";
        const settings = await getQuoteSettings(organizationId, tx);
        const noTemplate = new QuoteSendError(
          "no_template",
          "Pasaron más de 24 h desde el último mensaje del cliente. Para enviar fuera de esa ventana elige una plantilla aprobada (con {{1}} nombre, {{2}} folio y {{3}} enlace) en Ajustes de cotizaciones."
        );
        if (!settings.whatsappTemplateId) throw noTemplate;
        const templates = await tx
          .select({ id: schema.template.id, status: schema.template.status, body: schema.template.body })
          .from(schema.template)
          .where(scoped(schema.template.organizationId, organizationId, eq(schema.template.id, settings.whatsappTemplateId)))
          .limit(1);
        const template = templates[0];
        if (!template || template.status !== "approved" || countVariables(template.body) !== 3) throw noTemplate;
        templateId = template.id;
      }

      const credentials = await getCredentialsByOrg(organizationId);
      if (!credentials) throw new QuoteSendError("not_connected", "No hay un número de WhatsApp conectado");
      if (credentials.status === "reconnect_required") {
        throw new QuoteSendError("reconnect_required", "El token de WhatsApp expiró: reconecta el número en Configuración");
      }

      const sendId = newId("quoteSend");
      const linkId = await replaceQuoteLinkInTx(tx, { organizationId, quoteId, token, expiresAt: quote.validUntil, now });
      await tx.insert(schema.quoteSend).values({
        id: sendId,
        organizationId,
        quoteId,
        idempotencyKey,
        status: "pendiente",
        mode,
        templateId,
        quoteLinkId: linkId,
        sentBy: userId,
        createdAt: now,
      });
      return { prepared: { sendId, linkId, conversationId: row.conversation.id, mode, templateId, contactName: row.contactName } };
    });
  } catch (err) {
    if (isUniqueViolation(err, "quote_send_org_key_uq")) {
      // Otra petición con la MISMA clave ganó la carrera: su resultado vale.
      const winner = await attemptByKey(organizationId, idempotencyKey);
      if (winner) return toView(winner, now);
    }
    if (isUniqueViolation(err, "quote_send_one_pending_uq")) {
      throw new QuoteSendError("in_progress", "Ya hay un envío de esta cotización en curso");
    }
    throw err;
  }
  if ("existing" in outcome) return toView(outcome.existing, now);
  const { prepared } = outcome;

  // 4. Hablar con Meta (fuera de la transacción).
  const quote = (await getQuote(organizationId, quoteId))!;
  const folio = formatQuoteFolio(quote.number);
  const url = `${appBase()}/p/${token}`;
  const masked = maskedUrl(folio);
  const firstName = prepared.contactName.trim().split(/\s+/)[0] || "Hola";

  let messageId: string | null = null;
  try {
    if (prepared.mode === "documento") {
      const pdf = await buildPdf(organizationId, quote);
      const text = (link: string) =>
        `Hola ${firstName}, te comparto la cotización ${folio}. Puedes revisarla y aceptarla aquí: ${link}`;
      const result = await sendMediaMessage({
        conversationId: prepared.conversationId,
        organizationId,
        file: { data: Buffer.from(pdf), mimeType: "application/pdf", fileName: `Cotizacion-${folio}.pdf` },
        caption: text(url),
        storedCaption: text(masked),
        secrets: [url, token],
      });
      messageId = result.messageId;
    } else {
      const result = await sendTemplate({
        organizationId,
        conversationId: prepared.conversationId,
        templateId: prepared.templateId!,
        variables: [prepared.contactName.trim() || "cliente", folio, url],
        storedVariables: [prepared.contactName.trim() || "cliente", folio, masked],
      });
      messageId = result.messageId;
    }
  } catch (err) {
    const code = errorCodeOf(err);
    const failedMessageId = err instanceof SendError ? err.messageId ?? null : null;
    await getDb().transaction(async (tx) => {
      await tx
        .update(schema.quoteSend)
        .set({ status: "fallido", errorCode: code, messageId: failedMessageId, completedAt: new Date() })
        .where(scoped(schema.quoteSend.organizationId, organizationId, eq(schema.quoteSend.id, prepared.sendId)));
      await tx
        .update(schema.quoteLink)
        .set({ revokedAt: new Date() })
        .where(scoped(schema.quoteLink.organizationId, organizationId, eq(schema.quoteLink.id, prepared.linkId)));
    });
    console.error(
      `[cotizaciones] envío ${prepared.sendId} falló: ${code} ${redact(err instanceof Error ? err.message : String(err), [token, url])}`
    );
    return (await attemptView(organizationId, prepared.sendId, now))!;
  }

  // 5. Meta aceptó.
  const waRows = await getDb()
    .select({ waMessageId: schema.message.waMessageId })
    .from(schema.message)
    .where(scoped(schema.message.organizationId, organizationId, eq(schema.message.id, messageId)))
    .limit(1);
  const done = new Date();
  await getDb().transaction(async (tx) => {
    await tx
      .update(schema.quoteSend)
      .set({ status: "enviado", messageId, waMessageId: waRows[0]?.waMessageId ?? null, completedAt: done })
      .where(scoped(schema.quoteSend.organizationId, organizationId, eq(schema.quoteSend.id, prepared.sendId)));
    await tx
      .update(schema.quote)
      .set({ status: "enviada", sentAt: done, sentVia: "whatsapp", sentBy: userId, updatedAt: done })
      .where(scoped(schema.quote.organizationId, organizationId, eq(schema.quote.id, quoteId), eq(schema.quote.status, "borrador")));
  });
  publish(organizationId, { type: "quote.updated", data: { quoteId, status: "enviada" } });
  return (await attemptView(organizationId, prepared.sendId, now))!;
}

async function attemptView(organizationId: string, sendId: string, now: Date): Promise<QuoteSendView | null> {
  const rows = await getDb()
    .select()
    .from(schema.quoteSend)
    .where(scoped(schema.quoteSend.organizationId, organizationId, eq(schema.quoteSend.id, sendId)))
    .limit(1);
  return rows[0] ? toView(rows[0], now) : null;
}

async function buildPdf(organizationId: string, quote: NonNullable<Awaited<ReturnType<typeof getQuote>>>): Promise<Uint8Array> {
  const orgRows = await getDb()
    .select({ name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId))
    .limit(1);
  const name = orgRows[0]?.name ?? "";
  const logo = await getPublicLogo(organizationId, name);
  return renderQuotePdf({
    business: { name, logo },
    folio: formatQuoteFolio(quote.number),
    issuedAt: new Date(),
    validUntil: quote.validUntil,
    currency: quote.currency,
    pricesIncludeTax: quote.pricesIncludeTax,
    taxRateBps: quote.taxRateBps,
    subtotalCents: quote.subtotalCents,
    taxCents: quote.taxCents,
    totalCents: quote.totalCents,
    items: quote.items.map((item) => ({
      description: item.description,
      quantityMilli: item.quantityMilli,
      unitPriceCents: item.unitPriceCents,
      lineTotalCents: item.lineTotalCents,
    })),
  });
}

/**
 * El operador resuelve un intento INCIERTO (pendiente con más de 5 min):
 *  - "llego": el intento queda enviado y la cotización `enviada` (whatsapp).
 *  - "no_llego": el intento queda fallido, su enlace se revoca y la
 *    cotización sigue en `borrador`, lista para reintentar.
 */
export async function resolveUncertainSend(input: {
  organizationId: string;
  quoteId: string;
  sendId: string;
  userId: string;
  outcome: "llego" | "no_llego";
  now?: Date;
}): Promise<QuoteSendView> {
  const { organizationId, quoteId, sendId, userId, outcome } = input;
  if (!organizationId) throw new Error("resolveUncertainSend(): organizationId vacío");
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - SEND_UNCERTAIN_AFTER_MS);

  await getDb().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.quoteSend)
      .where(scoped(schema.quoteSend.organizationId, organizationId, eq(schema.quoteSend.id, sendId), eq(schema.quoteSend.quoteId, quoteId)))
      .for("update")
      .limit(1);
    const attempt = rows[0];
    if (!attempt) throw new QuoteSendError("not_found", "Intento de envío no encontrado");
    if (attempt.status !== "pendiente" || attempt.createdAt.getTime() > cutoff.getTime()) {
      throw new QuoteSendError("invalid_transition", "Solo se puede resolver un envío que quedó sin confirmar");
    }
    if (outcome === "llego") {
      await tx
        .update(schema.quoteSend)
        .set({ status: "enviado", resolution: "llego", resolvedBy: userId, completedAt: now })
        .where(scoped(schema.quoteSend.organizationId, organizationId, eq(schema.quoteSend.id, sendId)));
      await tx
        .update(schema.quote)
        .set({ status: "enviada", sentAt: attempt.createdAt, sentVia: "whatsapp", sentBy: attempt.sentBy ?? userId, updatedAt: now })
        .where(scoped(schema.quote.organizationId, organizationId, eq(schema.quote.id, quoteId), eq(schema.quote.status, "borrador")));
    } else {
      await tx
        .update(schema.quoteSend)
        .set({ status: "fallido", errorCode: "no_llego", resolution: "no_llego", resolvedBy: userId, completedAt: now })
        .where(scoped(schema.quoteSend.organizationId, organizationId, eq(schema.quoteSend.id, sendId)));
      if (attempt.quoteLinkId) {
        await tx
          .update(schema.quoteLink)
          .set({ revokedAt: now })
          .where(scoped(schema.quoteLink.organizationId, organizationId, eq(schema.quoteLink.id, attempt.quoteLinkId)));
      }
    }
  });
  if (outcome === "llego") publish(organizationId, { type: "quote.updated", data: { quoteId, status: "enviada" } });
  return (await attemptView(organizationId, sendId, now))!;
}
