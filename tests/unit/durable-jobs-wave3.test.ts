import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_JOB_ATTEMPTS,
  retryDelayMs,
  shouldDeadLetter,
} from "@/server/jobs/queue";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("Wave 3 - durable agent/Lab execution", () => {
  it("el pipeline ya no guarda debounce/running state en Map o setTimeout", () => {
    const pipeline = source("src/server/ai/pipeline.ts");

    expect(pipeline).not.toContain("__agentCoalesce");
    expect(pipeline).not.toContain("new Map");
    expect(pipeline).not.toContain("setTimeout(");
    expect(pipeline).toContain('import("@/server/jobs/queue")');
  });

  it("Lab se encola y no usa fire-and-forget in-process", () => {
    const runner = source("src/server/lab/runner.ts");

    expect(runner).toContain("await enqueueLabRun(organizationId, runId)");
    expect(runner).not.toContain("void executeRun");
    expect(runner).not.toContain("Promise.race");
    expect(runner).toContain("executeLabRun");
  });

  it("el arranque recupera runs y levanta consumers durables", () => {
    const instrumentation = source("src/instrumentation-node.ts");
    const worker = source("src/server/jobs/worker.ts");

    expect(instrumentation).toContain("startDurableWorkers");
    expect(instrumentation).not.toContain("Interrumpida por un reinicio");
    expect(worker).toContain("recoverRunningLabJobs");
  });

  it("la cola usa leases y SKIP LOCKED para varios procesos", () => {
    const queue = source("src/server/jobs/queue.ts");

    expect(queue.toLowerCase()).toContain("for update skip locked");
    expect(queue).toContain("lease_until");
    expect(queue).toContain("claimed_request_at");
    expect(queue).toContain("on conflict (conversation_id)");
    expect(queue).toContain("on conflict (run_id)");
  });

  it("propaga organizationId y mantiene mutaciones de jobs tenant-scoped", () => {
    const queue = source("src/server/jobs/queue.ts");
    const trigger = source("src/server/ai/trigger.ts");
    const ingest = source("src/server/inbox/ingest.ts");
    const worker = source("src/server/jobs/worker.ts");

    expect(queue).toContain("organizationId: string,\n  conversationId: string");
    expect(queue).toContain("schema.conversation.organizationId");
    expect(queue).toContain("schema.agentTestRun.organizationId");
    expect(queue).toContain("and organization_id = ${job.organizationId}");
    expect(trigger).toContain(
      "await scheduleAgentTurn(organizationId, conversationId)"
    );
    expect(ingest).toContain(
      "await maybeRunAgentTurn(organizationId, conversation.id)"
    );
    expect(worker).toContain("await completeLabJob(job)");
  });

  it("aplica backoff acotado al reintentar jobs", () => {
    expect(retryDelayMs(1)).toBe(5_000);
    expect(retryDelayMs(3)).toBe(15_000);
    expect(retryDelayMs(20)).toBe(60_000);
  });

  it("serializa JSON antes de cruzar el boundary postgres-js", () => {
    const audit = source("src/server/auth/audit.ts");
    const trace = source("src/server/lab/action-trace.ts");
    expect(audit).toContain("JSON.stringify(input.metadata)");
    expect(trace).toContain("JSON.stringify(input.trace)");
    expect(audit).not.toContain("${sql.json(");
    expect(trace).not.toContain("${sql.json(");
  });

  it("detiene poison jobs al alcanzar el límite", () => {
    expect(shouldDeadLetter(MAX_JOB_ATTEMPTS - 1)).toBe(false);
    expect(shouldDeadLetter(MAX_JOB_ATTEMPTS)).toBe(true);
    const queue = source("src/server/jobs/queue.ts");
    expect(queue).toContain("dead_letter_at is null");
    expect(queue).toContain('return "dead_letter"');
  });

  it("serializa instantes antes de cruzar el boundary postgres-js", () => {
    const queue = source("src/server/jobs/queue.ts");
    expect(queue).toContain("const dueAtIso = dueAt.toISOString()");
    expect(queue).toContain("if (typeof value === \"string\") return value");
    expect(queue).toContain(
      "const claimedRequestAtExact = job.claimedRequestAt"
    );
    expect(queue).not.toContain("due_at = ${dueAt},");
    expect(queue).not.toContain("requested_at <= ${job.claimedRequestAt}");
  });
});
