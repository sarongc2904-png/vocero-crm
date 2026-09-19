import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe("automatizaciones durables", () => {
  it("reclama con SKIP LOCKED, lease e idempotencia", () => {
    const queue = source("src/server/automations/queue.ts").toLowerCase();
    const migration = source("drizzle/0024_durable_automations.sql").toLowerCase();
    expect(queue).toContain("for update skip locked");
    expect(queue).toContain("lease_until");
    expect(migration).toContain("scheduled_automation_org_idempotency_uq");
  });

  it("exige plantilla fuera de ventana y cancela recordatorios de citas inactivas", () => {
    const worker = source("src/server/automations/worker.ts");
    expect(worker).toContain("isWindowOpen");
    expect(worker).toContain("template_required_outside_window");
    expect(worker).toContain('bookings[0]?.status !== "agendada"');
  });

  it("reprogramar o cancelar invalida recordatorios anteriores", () => {
    const agenda = source("src/server/agenda/service.ts");
    expect(agenda.match(/cancelBookingAutomations/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(agenda).toContain("scheduleBookingAutomations");
    expect(agenda).toContain("scheduleReviewRequests");
  });
});
