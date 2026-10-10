import { QuoteSettingsClient } from "@/components/settings/quote-settings-client";
import { hasOrganizationPermission } from "@/lib/auth/permissions";
import { requireQuotesPage } from "@/server/quotes/page-access";
import { getQuoteSettings, listQuoteTemplateOptions } from "@/server/quotes/settings";

export const dynamic = "force-dynamic";

/** Ajustes → Cotizaciones. Sin la bandera, no existe (notFound). */
export default async function QuoteSettingsPage() {
  const { session } = await requireQuotesPage("quotes.read");
  const [settings, templates] = await Promise.all([
    getQuoteSettings(session.organizationId),
    listQuoteTemplateOptions(session.organizationId),
  ]);
  const canEdit = hasOrganizationPermission(session.role, "settings.update", { isSuperadmin: session.isSuperadmin });
  return (
    <QuoteSettingsClient
      canEdit={canEdit}
      initial={{
        pricesIncludeTax: settings.pricesIncludeTax,
        taxRatePercent: settings.taxRateBps / 100,
        defaultValidityDays: settings.defaultValidityDays,
        whatsappTemplateId: settings.whatsappTemplateId,
      }}
      templates={templates.map((t) => ({
        id: t.id,
        name: t.name,
        language: t.language,
        body: t.body,
        eligible: t.eligible,
        reason: t.reason,
      }))}
    />
  );
}
