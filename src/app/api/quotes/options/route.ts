import { getQuoteFormOptions } from "@/server/quotes/crm";
import { quotesCrmRoute } from "@/server/quotes/crm-http";

export const dynamic = "force-dynamic";

/** GET /api/quotes/options — conversaciones y catálogo para el formulario. */
export const GET = quotesCrmRoute(["quotes.manage"], async (session) => {
  const options = await getQuoteFormOptions(session.organizationId);
  return Response.json({
    conversations: options.conversations.map((c) => ({
      id: c.id,
      contactName: c.contactName,
      lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    })),
    services: options.services,
    settings: options.settings,
  });
});
