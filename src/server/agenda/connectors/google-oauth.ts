import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";
import { GOOGLE_SCOPE } from "@/server/agenda/connectors/google";

const CALLBACK_PATH = "/api/settings/google/oauth/callback";
const STATE_TTL_MS = 10 * 60_000;

type StatePayload = {
  organizationId: string;
  exp: number;
};

export function getGoogleOAuthConfig(): {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  redirectUri: string;
} | null {
  const env = getEnv();
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    authorizeUrl: env.GOOGLE_OAUTH_AUTHORIZE_URL,
    redirectUri: new URL(CALLBACK_PATH, env.APP_BASE_URL).toString(),
  };
}

export function createGoogleOAuthState(organizationId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ organizationId, exp: Date.now() + STATE_TTL_MS } satisfies StatePayload)
  ).toString("base64url");
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

export function verifyGoogleOAuthState(state: string): StatePayload | null {
  const [payload, signature, extra] = state.split(".");
  if (!payload || !signature || extra) return null;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as StatePayload;
    if (!parsed.organizationId || !Number.isFinite(parsed.exp) || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function googleAuthorizationUrl(organizationId: string): string | null {
  const config = getGoogleOAuthConfig();
  if (!config) return null;
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", createGoogleOAuthState(organizationId));
  return url.toString();
}

function sign(payload: string): string {
  return createHmac("sha256", getEnv().BETTER_AUTH_SECRET)
    .update(payload)
    .digest("base64url");
}
