import { z } from "zod";
import { withOrgPermissions } from "@/lib/api";
import type { OrganizationPermission } from "@/lib/auth/permissions";
import type { SessionContext } from "@/lib/auth/session";
import { quotesDisabledResponse, quotesEnabled } from "@/server/quotes/flag";
import { quoteErrorResponse, quotePayload } from "@/server/quotes/http";
import type { QuoteDetail } from "@/server/quotes/crm";
import { MAX_QUOTE_ITEMS, MAX_QUOTE_NOTES } from "@/server/quotes/service";
import { sendViewPayload } from "@/server/quotes/send-http";

/**
 * Puerta única de `/api/quotes/*` (CRM con sesión):
 *  1. bandera COTIZACIONES — apagada, 404 sin tocar sesión ni base;
 *  2. sesión + permiso (`withOrgPermissions`): 401 / 403;
 *  3. `QuoteError` → su código HTTP (404 para todo id ajeno).
 * El `organizationId` sale SOLO de la sesión.
 */
export function quotesCrmRoute<Args extends unknown[]>(
  permissions: readonly OrganizationPermission[],
  handler: (session: SessionContext, ...args: Args) => Promise<Response>
): (...args: Args) => Promise<Response> {
  const guarded = withOrgPermissions(permissions, async (session, ...args: Args) => {
    try {
      return await handler(session, ...args);
    } catch (err) {
      return quoteErrorResponse(err);
    }
  });
  return async (...args: Args) => {
    if (!quotesEnabled()) return quotesDisabledResponse();
    return guarded(...args);
  };
}

const itemSchema = z
  .object({ serviceId: z.string().min(1).max(100), quantity: z.number().positive().default(1) })
  .strict();

/** Alta desde el CRM. Igual que el bot: el body nunca trae montos. */
export const crmCreateBodySchema = z
  .object({
    conversationId: z.string().min(1).max(100),
    items: z.array(itemSchema).min(1).max(MAX_QUOTE_ITEMS),
    notes: z.string().max(MAX_QUOTE_NOTES).nullish(),
    validityDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

/** Edición de un borrador: líneas, notas y (opcional) nueva vigencia. */
export const crmEditBodySchema = z
  .object({
    items: z.array(itemSchema).min(1).max(MAX_QUOTE_ITEMS),
    notes: z.string().max(MAX_QUOTE_NOTES).nullish(),
    validityDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

export function crmDetailPayload(detail: QuoteDetail) {
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  return {
    quote: {
      ...quotePayload(detail.quote),
      sentVia: detail.quote.sentVia,
      responseNote: detail.quote.responseNote,
      duplicatedFromId: detail.quote.duplicatedFromId,
    },
    contactName: detail.contactName,
    // Nunca el token: solo si hay un enlace vivo y desde cuándo.
    link: {
      active: detail.link.active,
      expiresAt: iso(detail.link.expiresAt),
      lastViewedAt: iso(detail.link.lastViewedAt),
      issuedAt: iso(detail.link.issuedAt),
    },
    createdByName: detail.createdByName,
    sentByName: detail.sentByName,
    duplicatedFrom: detail.duplicatedFrom,
    duplicates: detail.duplicates,
    latestSend: detail.latestSend ? sendViewPayload(detail.latestSend) : null,
  };
}
