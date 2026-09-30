import { redirect } from "next/navigation";
import { getSessionState } from "@/lib/auth/session";
import { getOnboardingState } from "@/server/commercial/onboarding";

export default async function Home() {
  const state = await getSessionState();

  // Sesión anónima → login
  if (state.status === "anonymous") {
    redirect("/login");
  }

  // Sesión sin organización → página de error
  if (state.status === "no_organization") {
    redirect("/organization-required");
  }

  // Sesión válida
  const { session } = state;

  // Superadmin → inbox directo
  if (session.isSuperadmin) {
    redirect("/inbox");
  }

  // Agent → inbox directo
  if (session.role === "agent") {
    redirect("/inbox");
  }

  // Owner/Admin → verificar onboarding
  const onboarding = await getOnboardingState(session.organizationId);
  const activationStep = onboarding.steps.find((step) => step.id === "activation");

  if (activationStep?.complete === true) {
    redirect("/inbox");
  }

  redirect("/onboarding");
}
