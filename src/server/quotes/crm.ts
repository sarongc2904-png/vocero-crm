import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import type { QuoteStatus } from "@/lib/db/schema";
import { formatQuoteFolio } from "@/server/quotes/numbering";
import { effectiveQuoteStatus, getQuote, type QuoteView } from "@/server/quotes/service";
import { getQuoteSettings, type QuoteSettings } from "@/server/quotes/settings";

/**
 * Lecturas para las pantallas del CRM. Todo filtrado por `organizationId` de
 * la sesión; ninguna devuelve el token de un enlace (solo si hay uno vivo).
 */

export const QUOTE_LIST_FILTERS = [
  "todas",
  "borrador",
  "enviada",
  "aceptada",
  "rechazada",
  "expirada",
  "cancelada",
  "bot",
] as const;
export type QuoteListFilter = (typeof QUOTE_LIST_FILTERS)[number];

export function isQuoteListFilter(value: unknown): value is QuoteListFilter {
  return typeof value === "string" && (QUOTE_LIST_FILTERS as readonly string[]).includes(value);
}

export type QuoteListRow = {
  id: string;
  folio: string;
  status: QuoteStatus;
  contactName: string;
  totalCents: number;
  currency: string;
  source: "manual" | "bot" | "ai";
  isTest: boolean;
  validUntil: Date;
  createdAt: Date;
};

export async function listQuotesForCrm(
  organizationId: string,
  options: { filter?: QuoteListFilter; limit?: number; now?: Date } = {}
): Promise<QuoteListRow[]> {
  const now = options.now ?? new Date();
  const filter = options.filter ?? "todas";
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 200);
  const q = schema.quote;

  // "enviada" y "expirada" se distinguen por la vigencia: la expiración se
  // calcula al leer, no se guarda.
  const condition =
    filter === "todas"
      ? undefined
      : filter === "bot"
        ? and(eq(q.source, "bot"), eq(q.status, "borrador"))
        : filter === "enviada"
          ? and(eq(q.status, "enviada"), gt(q.validUntil, now))
          : filter === "expirada"
            ? and(eq(q.status, "enviada"), lte(q.validUntil, now))
            : eq(q.status, filter);

  const rows = await getDb()
    .select({
      id: q.id,
      number: q.number,
      status: q.status,
      validUntil: q.validUntil,
      totalCents: q.totalCents,
      currency: q.currency,
      source: q.source,
      isTest: q.isTest,
      createdAt: q.createdAt,
      contactName: schema.contact.name,
    })
    .from(q)
    .innerJoin(
      schema.contact,
      and(eq(schema.contact.id, q.contactId), eq(schema.contact.organizationId, q.organizationId))
    )
    .where(scoped(q.organizationId, organizationId, condition))
    .orderBy(desc(q.createdAt), desc(q.number))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    folio: formatQuoteFolio(row.number),
    status: effectiveQuoteStatus(row, now),
    contactName: row.contactName,
    totalCents: row.totalCents,
    currency: row.currency,
    source: row.source,
    isTest: row.isTest,
    validUntil: row.validUntil,
    createdAt: row.createdAt,
  }));
}

export type QuoteDetail = {
  quote: QuoteView;
  contactName: string;
  link: { active: boolean; expiresAt: Date | null; lastViewedAt: Date | null; issuedAt: Date | null };
  createdByName: string | null;
  sentByName: string | null;
  duplicatedFrom: { id: string; folio: string } | null;
  duplicates: { id: string; folio: string; status: QuoteStatus }[];
};

export async function getQuoteDetailForCrm(
  organizationId: string,
  quoteId: string,
  now: Date = new Date()
): Promise<QuoteDetail | null> {
  const quote = await getQuote(organizationId, quoteId);
  if (!quote) return null;
  const db = getDb();

  const [contacts, links, users, parents, children] = await Promise.all([
    db
      .select({ name: schema.contact.name })
      .from(schema.contact)
      .where(scoped(schema.contact.organizationId, organizationId, eq(schema.contact.id, quote.contactId)))
      .limit(1),
    db
      .select({
        expiresAt: schema.quoteLink.expiresAt,
        lastViewedAt: schema.quoteLink.lastViewedAt,
        createdAt: schema.quoteLink.createdAt,
      })
      .from(schema.quoteLink)
      .where(
        scoped(
          schema.quoteLink.organizationId,
          organizationId,
          eq(schema.quoteLink.quoteId, quoteId),
          isNull(schema.quoteLink.revokedAt),
          gt(schema.quoteLink.expiresAt, now)
        )
      )
      .orderBy(desc(schema.quoteLink.createdAt))
      .limit(1),
    // Nombres de operadores: solo de usuarios que son miembros de ESTE negocio.
    db
      .select({ id: schema.user.id, name: schema.user.name })
      .from(schema.user)
      .innerJoin(
        schema.member,
        and(eq(schema.member.userId, schema.user.id), eq(schema.member.organizationId, organizationId))
      )
      .where(inArray(schema.user.id, [quote.createdBy, quote.sentBy].filter((id): id is string => Boolean(id)).concat("__none__"))),
    quote.duplicatedFromId
      ? db
          .select({ id: schema.quote.id, number: schema.quote.number })
          .from(schema.quote)
          .where(scoped(schema.quote.organizationId, organizationId, eq(schema.quote.id, quote.duplicatedFromId)))
          .limit(1)
      : Promise.resolve([]),
    db
      .select({ id: schema.quote.id, number: schema.quote.number, status: schema.quote.status, validUntil: schema.quote.validUntil })
      .from(schema.quote)
      .where(scoped(schema.quote.organizationId, organizationId, eq(schema.quote.duplicatedFromId, quoteId)))
      .orderBy(asc(schema.quote.number)),
  ]);

  const names = new Map(users.map((u) => [u.id, u.name]));
  const link = links[0];
  return {
    quote,
    contactName: contacts[0]?.name ?? "Contacto",
    link: {
      active: Boolean(link),
      expiresAt: link?.expiresAt ?? null,
      lastViewedAt: link?.lastViewedAt ?? null,
      issuedAt: link?.createdAt ?? null,
    },
    createdByName: quote.createdBy ? names.get(quote.createdBy) ?? null : null,
    sentByName: quote.sentBy ? names.get(quote.sentBy) ?? null : null,
    duplicatedFrom: parents[0] ? { id: parents[0].id, folio: formatQuoteFolio(parents[0].number) } : null,
    duplicates: children.map((c) => ({ id: c.id, folio: formatQuoteFolio(c.number), status: effectiveQuoteStatus(c, now) })),
  };
}

export type QuoteFormOptions = {
  conversations: { id: string; contactName: string; lastMessageAt: Date | null }[];
  services: { id: string; name: string; priceCents: number; currency: string }[];
  settings: QuoteSettings;
};

/**
 * Lo que el formulario de alta y edición necesita: conversaciones reales (no
 * del Laboratorio) y servicios ACTIVOS del negocio, con su precio de catálogo.
 */
export async function getQuoteFormOptions(organizationId: string): Promise<QuoteFormOptions> {
  const db = getDb();
  const [conversations, services, settings] = await Promise.all([
    db
      .select({
        id: schema.conversation.id,
        contactName: schema.contact.name,
        lastMessageAt: schema.conversation.lastMessageAt,
      })
      .from(schema.conversation)
      .innerJoin(
        schema.contact,
        and(
          eq(schema.contact.id, schema.conversation.contactId),
          eq(schema.contact.organizationId, schema.conversation.organizationId)
        )
      )
      .where(scoped(schema.conversation.organizationId, organizationId, eq(schema.conversation.isTest, false)))
      .orderBy(sql`${schema.conversation.lastMessageAt} desc nulls last`)
      .limit(200),
    db
      .select({
        id: schema.service.id,
        name: schema.service.name,
        priceCents: schema.service.priceCents,
        currency: schema.service.currency,
      })
      .from(schema.service)
      .where(scoped(schema.service.organizationId, organizationId, eq(schema.service.active, true)))
      .orderBy(asc(schema.service.name)),
    getQuoteSettings(organizationId),
  ]);
  return { conversations, services, settings };
}
