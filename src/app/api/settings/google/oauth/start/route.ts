import { apiError, withOrgPermissions } from "@/lib/api";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { googleAuthorizationUrl } from "@/server/agenda/connectors/google-oauth";

export const dynamic = "force-dynamic";

export const GET = withOrgPermissions(["settings.update"], async (session) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const url = googleAuthorizationUrl(session.organizationId);
  if (!url) {
    return apiError(
      503,
      "google_oauth_not_configured",
      "Google Calendar aún no está configurado para conexión con un clic"
    );
  }
  return Response.redirect(url, 302);
});
