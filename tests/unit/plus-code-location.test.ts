import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n"
  );
}

describe("Plus Code location resolver", () => {
  it("keeps the Google Maps key server-side", () => {
    const env = source("src/lib/env.ts");
    const compose = source("docker-compose.yml");
    const route = source("src/app/api/maps/resolve/route.ts");

    expect(env).toContain("GOOGLE_MAPS_API_KEY");
    expect(compose).toContain("GOOGLE_MAPS_API_KEY:");
    expect(route).toContain('url.searchParams.set("key", apiKey)');
    expect(route).toContain('withOrgPermissions(\n  ["conversations.reply"]');
  });

  it("composer resolves Plus Codes before sending a WhatsApp location", () => {
    const composer = source("src/components/inbox/composer.tsx");

    expect(composer).toContain("/api/maps/resolve");
    expect(composer).toContain("Plus Code");
    expect(composer).toContain("formattedAddress");
  });
});
