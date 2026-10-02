export const BUSINESS_KB_PREFIX = "NEGOCIO\n";
export const POLICIES_KB_PREFIX = "HORARIOS Y POLÍTICAS\n";

export type WizardProfile = {
  enabled: boolean;
  name: string;
  tone: string | null;
  instructions: string | null;
  escalationRules: string | null;
  greeting: string | null;
};

export type WizardKbEntry = {
  id: string;
  kind: "qa" | "block";
  content: string | null;
};

export type WizardDocument = { status: string };
export type WizardService = { active: boolean };
export type WizardProfessional = { status: string };

export function findWizardEntry(
  entries: WizardKbEntry[],
  prefix: string
): WizardKbEntry | undefined {
  return entries.find(
    (entry) => entry.kind === "block" && entry.content?.startsWith(prefix)
  );
}

export function wizardEntryBody(
  entries: WizardKbEntry[],
  prefix: string
): string {
  return findWizardEntry(entries, prefix)?.content?.slice(prefix.length) ?? "";
}

export function deriveAgentWizardState(input: {
  profile: WizardProfile;
  entries: WizardKbEntry[];
  documents: WizardDocument[];
  services: WizardService[];
  professionals: WizardProfessional[];
  agendaHasHours: boolean;
  tested: boolean;
}) {
  const activeDocuments = input.documents.filter(
    (document) => document.status === "ready"
  ).length;
  const reviewDocuments = input.documents.filter(
    (document) => document.status === "review"
  ).length;
  const agendaConfigured =
    input.services.some((service) => service.active) &&
    input.professionals.some((professional) => professional.status === "active") &&
    input.agendaHasHours;

  return {
    business: Boolean(findWizardEntry(input.entries, BUSINESS_KB_PREFIX)),
    personality: Boolean(
      input.profile.name.trim() &&
        (input.profile.tone?.trim() || input.profile.instructions?.trim())
    ),
    services: input.services.some((service) => service.active),
    policies: Boolean(findWizardEntry(input.entries, POLICIES_KB_PREFIX)),
    documents: activeDocuments > 0,
    activeDocuments,
    reviewDocuments,
    handoff: Boolean(input.profile.escalationRules?.trim()),
    agenda: agendaConfigured,
    tested: input.tested,
    active: input.profile.enabled,
    criticalReady: Boolean(input.profile.name.trim()),
  };
}
