import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("observabilidad de mensajes fallidos", () => {
  it("solo mantiene alerta cuando no hubo un envío posterior", () => {
    const inbox = source("src/server/inbox/queries.ts");

    expect(inbox).toContain("failed.status = 'failed'");
    expect(inbox).toContain("later.created_at > failed.created_at");
    expect(inbox).toContain("sendFailed");
  });

  it("aparece como alerta operativa en dashboard", () => {
    const metrics = source("src/server/dashboard/metrics.ts");
    const page = source("src/app/(app)/dashboard/page.tsx");

    expect(metrics).toContain("failed_outgoing");
    expect(metrics).toContain("failedOutgoing");
    expect(page).toContain("Mensajes no enviados");
    expect(page).toContain('href="/inbox"');
  });
});
