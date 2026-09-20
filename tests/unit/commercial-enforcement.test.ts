import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("enforcement comercial end-to-end", () => {
  it("bloquea APIs autenticadas salvo superficies comerciales explícitas", () => {
    const api = source("src/lib/api.ts");
    const subscription = source("src/app/api/subscription/route.ts");

    expect(api).toContain("subscription_required");
    expect(api).toContain("getCommercialAccess(session.organizationId)");
    expect(api).toContain("allowBlockedCommercialAccess");
    expect(subscription).toContain("allowBlockedCommercialAccess: true");
  });

  it("la ingesta persiste el inbound antes de decidir si corre IA", () => {
    const ingest = source("src/server/inbox/ingest.ts");

    expect(ingest).toContain("await maybeRunAgentTurn(organizationId, conversation.id)");
    expect(ingest.indexOf(".insert(schema.message)")).toBeLessThan(
      ingest.indexOf("await maybeRunAgentTurn(organizationId, conversation.id)")
    );
  });

  it("no encola IA cuando el tenant está comercialmente bloqueado", () => {
    const trigger = source("src/server/ai/trigger.ts");

    expect(trigger).toContain("hasCommercialAccess");
    expect(trigger).toContain("if (!(await hasCommercialAccess(organizationId))) return");
    expect(trigger).toContain("await scheduleAgentTurn(organizationId, conversationId)");
  });

  it("un job ya encolado vuelve a validar el entitlement antes de usar IA", () => {
    const pipeline = source("src/server/ai/pipeline.ts");

    expect(pipeline).toContain("hasCommercialAccess");
    expect(pipeline).toContain("if (!(await hasCommercialAccess(organizationId))) return");
    expect(
      pipeline.indexOf("if (!(await hasCommercialAccess(organizationId))) return")
    ).toBeLessThan(pipeline.indexOf("const result = await chatJson"));
  });

  it("cancela automatizaciones salientes de tenants inactivos", () => {
    const worker = source("src/server/automations/worker.ts");

    expect(worker).toContain("hasCommercialAccess(job.organizationId)");
    expect(worker).toContain(
      'await finishAutomation(job, "cancelled", "subscription_inactive")'
    );
    expect(worker.indexOf("hasCommercialAccess(job.organizationId)")).toBeLessThan(
      worker.indexOf("await sendText({")
    );
  });
});
