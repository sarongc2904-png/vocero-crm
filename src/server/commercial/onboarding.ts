import { getDb, getSql, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";

export type OnboardingStep = {
  id: string;
  label: string;
  complete: boolean;
  optional?: boolean;
  href: string;
};

export async function getOnboardingState(organizationId: string) {
  const rows = await getSql()`
    select
      exists(select 1 from calendar_settings where organization_id = ${organizationId}) as timezone,
      exists(select 1 from meta_credentials where organization_id = ${organizationId}) as whatsapp,
      exists(select 1 from service where organization_id = ${organizationId} and active = true) as services,
      exists(select 1 from professional where organization_id = ${organizationId} and status = 'active') as professionals,
      exists(select 1 from professional_availability where organization_id = ${organizationId}) as hours,
      exists(select 1 from google_credentials where organization_id = ${organizationId} and status = 'connected') as calendar,
      exists(select 1 from agent_profile where organization_id = ${organizationId} and length(coalesce(instructions, '')) > 0) as agent,
      exists(select 1 from agent_test_run where organization_id = ${organizationId} and status = 'done') as test,
      exists(select 1 from onboarding_progress where organization_id = ${organizationId} and activated_at is not null) as activation
  `;
  const fact = (rows[0] ?? {}) as Record<string, boolean>;
  const steps: OnboardingStep[] = [
    { id: "business", label: "Negocio", complete: true, href: "/settings/branding" },
    { id: "timezone", label: "Zona horaria", complete: Boolean(fact.timezone), href: "/settings/calendar" },
    { id: "whatsapp", label: "WhatsApp", complete: Boolean(fact.whatsapp), href: "/settings/whatsapp" },
    { id: "services", label: "Servicios", complete: Boolean(fact.services), href: "/settings/beauty" },
    { id: "professionals", label: "Profesionales", complete: Boolean(fact.professionals), href: "/settings/beauty" },
    { id: "hours", label: "Horarios", complete: Boolean(fact.hours), href: "/settings/beauty" },
    { id: "calendar", label: "Google Calendar", complete: Boolean(fact.calendar), optional: true, href: "/settings/calendar" },
    { id: "agent", label: "Conocimiento del agente", complete: Boolean(fact.agent), href: "/agent" },
    { id: "test", label: "Prueba de conversación", complete: Boolean(fact.test), href: "/lab" },
    { id: "activation", label: "Activación", complete: Boolean(fact.activation), href: "/onboarding" },
  ];
  const required = steps.filter((step) => !step.optional && step.id !== "activation");
  return {
    steps,
    readyToActivate: required.every((step) => step.complete),
    completed: steps.filter((step) => step.complete).length,
    total: steps.length,
  };
}

export async function activateOnboarding(organizationId: string) {
  const state = await getOnboardingState(organizationId);
  if (!state.readyToActivate) return false;
  const completedSteps = state.steps
    .filter((step) => step.complete || step.id === "activation")
    .map((step) => step.id);
  await getDb()
    .insert(schema.onboardingProgress)
    .values({
      id: newId("onboardingProgress"),
      organizationId,
      currentStep: 10,
      completedSteps,
      activatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.onboardingProgress.organizationId,
      set: {
        currentStep: 10,
        completedSteps,
        activatedAt: new Date(),
        updatedAt: new Date(),
      },
    });
  return true;
}
