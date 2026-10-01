import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n"
  );
}

describe("Google Calendar OAuth one-click", () => {
  it("firma state con expiración y scope mínimo de Calendar", () => {
    const text = source("src/server/agenda/connectors/google-oauth.ts");
    expect(text).toContain('createHmac("sha256", getEnv().BETTER_AUTH_SECRET)');
    expect(text).toContain("STATE_TTL_MS = 10 * 60_000");
    expect(text).toContain('url.searchParams.set("scope", GOOGLE_SCOPE)');
    expect(text).toContain('url.searchParams.set("access_type", "offline")');
    expect(text).toContain('url.searchParams.set("prompt", "consent")');
  });

  it("el callback queda atado al tenant autenticado y valida antes de guardar", () => {
    const text = source("src/app/api/settings/google/oauth/callback/route.ts");
    expect(text).toContain("verified.organizationId !== session.organizationId");
    expect(text).toContain('grant_type: "authorization_code"');
    expect(text).toContain("await googleConnector.testConnection(credentials)");
    expect(text).toContain("await saveGoogleCredentials({");
    expect(text.indexOf("testConnection(credentials)")).toBeLessThan(
      text.indexOf("saveGoogleCredentials({")
    );
  });

  it("la UI ofrece conexión con un clic cuando la app OAuth está configurada", () => {
    const text = source("src/components/settings/connector-credentials.tsx");
    expect(text).toContain('window.location.assign("/api/settings/google/oauth/start")');
    expect(text).toContain("Conectar Google Calendar");
    expect(text).toContain("oauthAvailable");
  });

  it("producción recibe las credenciales globales de la app OAuth", () => {
    const compose = source("docker-compose.yml");
    const env = source("src/lib/env.ts");
    expect(env).toContain("GOOGLE_OAUTH_CLIENT_ID");
    expect(env).toContain("GOOGLE_OAUTH_CLIENT_SECRET");
    expect(compose).toContain("GOOGLE_OAUTH_CLIENT_ID:");
    expect(compose).toContain("GOOGLE_OAUTH_CLIENT_SECRET:");
  });
});
