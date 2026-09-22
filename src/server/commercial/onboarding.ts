import { getDb, getSql, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";

export type OnboardingStep = {
  id: string;
  label: string;
  complete: boolean;
  optional?: boolean;
  href: string;
};

export type OnboardingOperationalStatus =
  | "por_configurar"
  | "configurando"
  | "listo_para_activar"
  | "listo_para_operar";

function deriveOperationalStatus(input: {
  requiredCompleted: number;
  requiredTotal: number;
  activated: boolean;
}): OnboardingOperationalStatus {
  if (input.activated) return "listo_para_operar";
  if (input.requiredCompleted >= input.requiredTotal) return "listo_para_activar";
  if (input.requiredCompleted > 1) return "configurando";
  return "por_configurar";
}

async function persistProgress(input: {
  organizationId: string;
  steps: OnboardingStep[];
  readyToActivate: boolean;
  alreadyActivated: boolean;
  activate?: boolean;
}) {
  const completedSteps = input.steps
    .filter((step) => step.complete)
    .map((step) => step.id);
  const firstIncompleteIndex = input.steps.findIndex(
    (step) => !step.complete && !step.optional && step.id !== "activation"
  );
  const currentStep =
    firstIncompleteIndex >= 0 ? firstIncompleteIndex + 1 : input.steps.length;
  const activatedAt =
    input.activate && input.readyToActivate && !input.alreadyActivated
      ? new Date()
      : null;

  await getDb()
    .insert(schema.onboardingProgress)
    .values({
      id: newId("onboardingProgress"),
      organizationId: input.organizationId,
      currentStep,
      completedSteps:
        input.readyToActivate && !completedSteps.includes("activation")
          ? [...completedSteps, "activation"]
          : completedSteps,
      activatedAt,
    })
    .onConflictDoUpdate({
      target: schema.onboardingProgress.organizationId,
      set: {
        currentStep,
        completedSteps:
          input.readyToActivate && !completedSteps.includes("activation")
            ? [...completedSteps, "activation"]
            : completedSteps,
        ...(activatedAt ? { activatedAt } : {}),
        updatedAt: new Date(),
      },
    });
}

export async function getOnboardingState(organizationId: string) {
  const rows = await getSql()`
    select
      exists(
        select 1
        from organization
        where id = ${organizationId}
          and length(trim(name)) > 1
      ) as business,
      exists(select 1 from calendar_settings where organization_id = ${organizationId}) as timezone,
      exists(
        select 1
        from meta_credentials
        where organization_id = ${organizationId}
          and status = 'connected'
      ) as whatsapp,
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
    {
      id: "business",
      label: "Datos del negocio",
      complete: Boolean(fact.business),
      href: "/settings/branding",
    },
    {
      id: "whatsapp",
      label: "Conecta WhatsApp",
      complete: Boolean(fact.whatsapp),
      href: "/settings/whatsapp",
    },
    {
      id: "agent",
      label: "Enséñale a la IA sobre tu negocio",
      complete: Boolean(fact.agent),
      href: "/agent",
    },
    {
      id: "timezone",
      label: "Horario y zona del negocio",
      complete: Boolean(fact.timezone),
      optional: true,
      href: "/settings/calendar",
    },
    {
      id: "calendar",
      label: "Google Calendar",
      complete: Boolean(fact.calendar),
      optional: true,
      href: "/settings/calendar",
    },
    {
      id: "test",
      label: "Haz una prueba",
      complete: Boolean(fact.test),
      href: "/lab",
    },
    {
      id: "activation",
      label: "Listo para operar",
      complete: Boolean(fact.activation),
      href: "/onboarding",
    },
  ];

  const required = steps.filter(
    (step) => !step.optional && step.id !== "activation"
  );
  const requiredCompleted = required.filter((step) => step.complete).length;
  const readyToActivate = requiredCompleted === required.length;

  await persistProgress({
    organizationId,
    steps,
    readyToActivate,
    alreadyActivated: Boolean(fact.activation),
  });

  const operationalStatus = deriveOperationalStatus({
    requiredCompleted,
    requiredTotal: required.length,
    activated: Boolean(fact.activation),
  });

  const nextStep =
    steps.find(
      (step) =>
        !step.complete &&
        !step.optional &&
        step.id !== "activation"
    ) ?? null;

  return {
    steps,
    nextStep,
    readyToActivate,
    operationalStatus,
    requiredCompleted,
    requiredTotal: required.length,
    completed: steps.filter((step) => step.complete).length,
    total: steps.length,
  };
}

export async function activateOnboarding(organizationId: string) {
  const state = await getOnboardingState(organizationId);
  if (!state.readyToActivate) return false;

  await persistProgress({
    organizationId,
    steps: state.steps,
    readyToActivate: true,
    alreadyActivated: Boolean(
      state.steps.find((step) => step.id === "activation")?.complete
    ),
    activate: true,
  });
  return true;
}
