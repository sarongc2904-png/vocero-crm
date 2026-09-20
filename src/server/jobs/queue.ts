import { eq } from "drizzle-orm";
import { scoped } from "@/lib/db/tenant";
import { getDb, getSql, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { getEnv } from "@/lib/env";

export type DurableJobKind = "agent_turn" | "lab_run";

export type DurableJob = {
  id: string;
  kind: DurableJobKind;
  organizationId: string;
  conversationId: string | null;
  runId: string | null;
  requestedAt: Date;
  claimedRequestAt: Date;
  attempts: number;
};

const LEASE_MINUTES = 15;
export const MAX_JOB_ATTEMPTS = 8;

export async function enqueueAgentTurn(
  organizationId: string,
  conversationId: string
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.conversation.id })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.id, conversationId)
      )
    )
    .limit(1);
  if (!rows[0]) return;

  const delay = Math.max(0, getEnv().AGENT_COALESCE_MS);
  const dueAt = new Date(Date.now() + delay);
  // El cliente postgres puede vivir en otro realm del bundle de Next. Pasar
  // el Date crudo hace que su `instanceof Date` no siempre lo reconozca y
  // termine intentando medirlo como string. ISO conserva exactamente el
  // instante y PostgreSQL lo castea a timestamp de forma determinista.
  const dueAtIso = dueAt.toISOString();
  const sql = getSql();

  await sql`
    insert into durable_job (
      id, kind, organization_id, conversation_id,
      requested_at, due_at, created_at, updated_at
    )
    values (
      ${newId("backgroundJob")}, 'agent_turn', ${organizationId}, ${conversationId},
      now(), ${dueAtIso}, now(), now()
    )
    on conflict (conversation_id) do update
      set organization_id = excluded.organization_id,
          requested_at = now(),
          due_at = excluded.due_at,
          attempts = 0,
          dead_letter_at = null,
          last_error = null,
          updated_at = now()
  `;
}

export async function enqueueLabRun(
  organizationId: string,
  runId: string
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.agentTestRun.id })
    .from(schema.agentTestRun)
    .where(
      scoped(
        schema.agentTestRun.organizationId,
        organizationId,
        eq(schema.agentTestRun.id, runId)
      )
    )
    .limit(1);
  if (!rows[0]) return;

  const sql = getSql();
  await sql`
    insert into durable_job (
      id, kind, organization_id, run_id,
      requested_at, due_at, created_at, updated_at
    )
    values (
      ${newId("backgroundJob")}, 'lab_run', ${organizationId}, ${runId},
      now(), now(), now(), now()
    )
    on conflict (run_id) do update
      set organization_id = excluded.organization_id,
          requested_at = now(),
          due_at = now(),
          last_error = null,
          updated_at = now()
      where durable_job.dead_letter_at is null
  `;
}

export async function recoverRunningLabJobs(): Promise<number> {
  const db = getDb();
  const runs = await db
    .select({
      id: schema.agentTestRun.id,
      organizationId: schema.agentTestRun.organizationId,
    })
    .from(schema.agentTestRun)
    .where(eq(schema.agentTestRun.status, "running"));

  for (const run of runs) {
    await enqueueLabRun(run.organizationId, run.id);
  }
  return runs.length;
}

export async function claimNextJob(
  kind: DurableJobKind
): Promise<DurableJob | null> {
  const sql = getSql();
  const rows = await sql`
    with candidate as (
      select id
      from durable_job
      where kind = ${kind}
        and due_at <= now()
        and dead_letter_at is null
        and attempts < ${MAX_JOB_ATTEMPTS}
        and (lease_until is null or lease_until < now())
      order by due_at asc, created_at asc
      for update skip locked
      limit 1
    )
    update durable_job as j
    set lease_until = now() + make_interval(mins => ${LEASE_MINUTES}),
        claimed_request_at = j.requested_at,
        attempts = j.attempts + 1,
        updated_at = now()
    from candidate
    where j.id = candidate.id
    returning
      j.id,
      j.kind,
      j.organization_id,
      j.conversation_id,
      j.run_id,
      j.requested_at,
      j.claimed_request_at,
      j.attempts
  `;
  const row = rows[0] as
    | {
        id: string;
        kind: DurableJobKind;
        organization_id: string;
        conversation_id: string | null;
        run_id: string | null;
        requested_at: Date;
        claimed_request_at: Date;
        attempts: number;
      }
    | undefined;
  if (!row) return null;

  return {
    id: row.id,
    kind: row.kind,
    organizationId: row.organization_id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    requestedAt: row.requested_at,
    claimedRequestAt: row.claimed_request_at,
    attempts: row.attempts,
  };
}

export async function completeAgentJob(job: DurableJob): Promise<void> {
  const sql = getSql();
  const claimedRequestAtIso = job.claimedRequestAt.toISOString();

  // Si nadie pidió otro turno mientras este corría, la fila puede desaparecer.
  const deleted = await sql`
    delete from durable_job
    where id = ${job.id}
      and organization_id = ${job.organizationId}
      and requested_at <= ${claimedRequestAtIso}
    returning id
  `;
  if (deleted.length > 0) return;

  // Llegó otro inbound mientras el lease estaba activo: liberar y procesar de
  // nuevo con el estado más reciente. No se pierde el turno aunque el proceso
  // se reinicie entre ambos.
  await sql`
    update durable_job
    set lease_until = null,
        claimed_request_at = null,
        due_at = least(due_at, now()),
        updated_at = now()
    where id = ${job.id}
      and organization_id = ${job.organizationId}
  `;
}

export async function completeLabJob(job: DurableJob): Promise<void> {
  const sql = getSql();
  await sql`
    delete from durable_job
    where id = ${job.id}
      and organization_id = ${job.organizationId}
  `;
}

export function retryDelayMs(attempts: number): number {
  return Math.min(60_000, Math.max(5_000, attempts * 5_000));
}

export function shouldDeadLetter(attempts: number): boolean {
  return attempts >= MAX_JOB_ATTEMPTS;
}

export async function releaseFailedJob(
  job: DurableJob,
  error: unknown
): Promise<"retry" | "dead_letter"> {
  const sql = getSql();
  const dueAt = new Date(Date.now() + retryDelayMs(job.attempts));
  const dueAtIso = dueAt.toISOString();
  const detail = String(error).slice(0, 2000);
  if (shouldDeadLetter(job.attempts)) {
    await sql`
      update durable_job
      set lease_until = null,
          claimed_request_at = null,
          last_error = ${detail},
          dead_letter_at = now(),
          updated_at = now()
      where id = ${job.id}
        and organization_id = ${job.organizationId}
    `;
    return "dead_letter";
  }
  await sql`
    update durable_job
    set lease_until = null,
        claimed_request_at = null,
        due_at = ${dueAtIso},
        last_error = ${detail},
        updated_at = now()
    where id = ${job.id}
      and organization_id = ${job.organizationId}
  `;
  return "retry";
}

export async function getDurableJobMetrics(): Promise<{
  pending: number;
  leased: number;
  deadLetter: number;
}> {
  const rows = await getSql()`
    select
      count(*) filter (where dead_letter_at is null)::int as pending,
      count(*) filter (where dead_letter_at is null and lease_until > now())::int as leased,
      count(*) filter (where dead_letter_at is not null)::int as dead_letter
    from durable_job
  `;
  const row = rows[0] as
    | { pending: number; leased: number; dead_letter: number }
    | undefined;
  return {
    pending: row?.pending ?? 0,
    leased: row?.leased ?? 0,
    deadLetter: row?.dead_letter ?? 0,
  };
}
