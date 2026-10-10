import Link from "next/link";
import { QuoteEditor } from "@/components/quotes/quote-editor";
import { getQuoteFormOptions } from "@/server/quotes/crm";
import { requireQuotesPage } from "@/server/quotes/page-access";

export const dynamic = "force-dynamic";

export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ conversationId?: string }>;
}) {
  const { session } = await requireQuotesPage("quotes.manage");
  const options = await getQuoteFormOptions(session.organizationId);
  const requested = (await searchParams).conversationId;
  // Solo se preselecciona si la conversación es de ESTE negocio (y no del Lab).
  const initialConversationId = options.conversations.some((c) => c.id === requested) ? requested : undefined;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b px-4 py-3 sm:px-6 sm:py-4">
        <p className="text-xs text-text-3">
          <Link href="/quotes" className="underline">
            Cotizaciones
          </Link>{" "}
          / Nueva
        </p>
        <h2 className="text-[17px] font-bold tracking-tight">Nueva cotización</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="max-w-3xl">
          <QuoteEditor
            mode="create"
            initialConversationId={initialConversationId}
            options={{
              conversations: options.conversations.map((c) => ({ id: c.id, contactName: c.contactName })),
              services: options.services,
              settings: options.settings,
            }}
          />
        </div>
      </div>
    </div>
  );
}
