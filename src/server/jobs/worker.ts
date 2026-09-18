import { runAgentTurn } from "@/server/ai/pipeline";
import { executeLabRun } from "@/server/lab/runner";
import {
  claimNextJob,
  completeAgentJob,
  completeLabJob,
  recoverRunningLabJobs,
  releaseFailedJob,
  type DurableJob,
  type DurableJobKind,
} from "@/server/jobs/queue";

type WorkerState = {
  timers?: Partial<Record<DurableJobKind, ReturnType<typeof setInterval>>>;
  running?: Partial<Record<DurableJobKind, boolean>>;
};

const globalForJobs = globalThis as unknown as {
  __durableWorkers?: WorkerState;
};

function state(): WorkerState {
  if (!globalForJobs.__durableWorkers) {
    globalForJobs.__durableWorkers = { timers: {}, running: {} };
  }
  return globalForJobs.__durableWorkers;
}

async function processJob(job: DurableJob): Promise<void> {
  try {
    if (job.kind === "agent_turn") {
      if (!job.conversationId) throw new Error("agent_turn sin conversationId");
      await runAgentTurn(job.conversationId, job.organizationId);
      await completeAgentJob(job);
      return;
    }

    if (!job.runId) throw new Error("lab_run sin runId");
    await executeLabRun(job.runId, job.organizationId);
    await completeLabJob(job);
  } catch (err) {
    console.error(`[jobs] ${job.kind} falló:`, err);
    await releaseFailedJob(job, err);
  }
}

async function drain(kind: DurableJobKind, maxJobs: number): Promise<void> {
  const s = state();
  if (s.running?.[kind]) return;
  s.running ??= {};
  s.running[kind] = true;
  try {
    for (let i = 0; i < maxJobs; i += 1) {
      const job = await claimNextJob(kind);
      if (!job) return;
      await processJob(job);
    }
  } finally {
    s.running[kind] = false;
  }
}

function startLoop(
  kind: DurableJobKind,
  intervalMs: number,
  maxJobs: number
): void {
  const s = state();
  s.timers ??= {};
  if (s.timers[kind]) return;

  void drain(kind, maxJobs);
  const timer = setInterval(() => {
    void drain(kind, maxJobs);
  }, intervalMs);
  timer.unref?.();
  s.timers[kind] = timer;
}

/**
 * Arranca consumidores locales sobre una cola cuya verdad vive en Postgres.
 * El interval NO contiene estado de negocio: si el proceso muere, los jobs y
 * sus leases sobreviven y otro proceso puede reclamarlos al expirar el lease.
 */
export async function startDurableWorkers(): Promise<void> {
  const recovered = await recoverRunningLabJobs();
  if (recovered > 0) {
    console.log(
      `[boot] ${recovered} corrida(s) de Lab aseguradas en la cola durable`
    );
  }

  // Agent: baja latencia y pequeños lotes. Lab: un run por vez por proceso para
  // no competir por CPU/LLM con la bandeja; SKIP LOCKED permite varios procesos.
  startLoop("agent_turn", 1_000, 10);
  startLoop("lab_run", 2_000, 1);
}
