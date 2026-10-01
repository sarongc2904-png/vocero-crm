import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("tenant scope de mutaciones críticas", () => {
  it.each([
    ["src/server/inbox/send.ts", "schema.conversation.organizationId"],
    ["src/server/whatsapp/templates.ts", "schema.conversation.organizationId"],
    ["src/server/inbox/lead-activity.ts", "schema.lead.organizationId"],
    ["src/server/agenda/service.ts", "schema.booking.organizationId"],
    ["src/app/api/bot/reset/route.ts", "schema.conversation.organizationId"],
    ["src/app/api/bot/handoff/route.ts", "schema.conversation.organizationId"],
  ])("%s conserva organizationId en sus mutaciones", (path, scope) => {
    expect(source(path)).toContain(scope);
  });

  it("la ingesta scopea mensajes y conversaciones al actualizar", () => {
    const ingest = source("src/server/inbox/ingest.ts");

    expect(ingest).toContain("eq(schema.message.organizationId, organizationId)");
    expect(ingest).toContain(
      "eq(schema.conversation.organizationId, organizationId)"
    );
  });
});
