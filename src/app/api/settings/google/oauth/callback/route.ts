import { withOrgPermissions } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { auditPrivilegedAction } from "@/server/auth/audit";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { googleConnector } from "@/server/agenda/connectors/google";
import { saveGoogleCredentials } from "@/server/agenda/connectors/google-credentials";
import {
  getGoogleOAuthConfig,
  verifyGoogleOAuthState,
} from "@/server/agenda/connectors/google-oauth";

export const dynamic = "force-dynamic";

function back(status: "connected" | "error"): Response {
  return Response.redirect(
    new URL(`/settings/calendar?google=${status}`, getEnv().APP_BASE_URL),
    302
  );
}

export const GET = withOrgPermissions(
  ["settings.update"],
  async (session, req: Request) => {
    if (!agendaEnabled()) return agendaDisabledResponse();

    const config = getGoogleOAuthConfig();
    if (!config) return back("error");

    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const providerError = url.searchParams.get("error");
    if (providerError || !code || !state) return back("error");

    const verified = verifyGoogleOAuthState(state);
    if (!verified || verified.organizationId !== session.organizationId) {
      return back("error");
    }

    let tokenResponse: Response;
    try {
      tokenResponse = await fetch(`${getEnv().GOOGLE_OAUTH_BASE_URL}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          grant_type: "authorization_code",
        }).toString(),
      });
    } catch (err) {
      console.error("[google-oauth] token exchange failed:", err);
      return back("error");
    }

    if (!tokenResponse.ok) {
      console.error(
        "[google-oauth] token exchange rejected:",
        tokenResponse.status,
        await tokenResponse.text().catch(() => "")
      );
      return back("error");
    }

    const tokens = (await tokenResponse.json().catch(() => null)) as {
      refresh_token?: string;
    } | null;
    const refreshToken = tokens?.refresh_token?.trim();
    if (!refreshToken) {
      console.error("[google-oauth] Google did not return a refresh_token");
      return back("error");
    }

    const credentials = {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken,
      calendarId: "primary",
      status: "connected" as const,
    };

    const check = await googleConnector.testConnection(credentials);
    if (!check.ok) {
      console.error("[google-oauth] connection test failed:", check.error);
      return back("error");
    }

    await saveGoogleCredentials({
      organizationId: session.organizationId,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken,
      calendarId: "primary",
    });

    await auditPrivilegedAction(session, {
      action: "settings.google.oauth_connect",
      targetType: "channel_credentials",
      targetId: session.organizationId,
      metadata: { connector: "google", calendarId: "primary" },
    });

    return back("connected");
  }
);
