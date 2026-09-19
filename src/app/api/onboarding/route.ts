import { apiError, withOrgPermissions } from "@/lib/api";
import {
  activateOnboarding,
  getOnboardingState,
} from "@/server/commercial/onboarding";

export const dynamic = "force-dynamic";

export const GET = withOrgPermissions(["settings.read"], async (session) => {
  return Response.json({ onboarding: await getOnboardingState(session.organizationId) });
});

export const POST = withOrgPermissions(["settings.update"], async (session) => {
  const activated = await activateOnboarding(session.organizationId);
  if (!activated) {
    return apiError(
      409,
      "onboarding_incomplete",
      "Completa los pasos obligatorios antes de activar"
    );
  }
  return Response.json({ onboarding: await getOnboardingState(session.organizationId) });
});
