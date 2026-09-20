import postgres from "postgres";

const [mode] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url || !mode) process.exit(2);

const sql = postgres(url, { max: 1, onnotice: () => {} });

async function claimAgent() {
  const rows = await sql`
    with candidate as (
      select id from durable_job
      where kind = 'agent_turn'
        and due_at <= now()
        and dead_letter_at is null
        and attempts < 8
        and (lease_until is null or lease_until < now())
      order by due_at, created_at
      for update skip locked
      limit 1
    )
    update durable_job j
    set lease_until = now() + interval '10 minutes',
        claimed_request_at = j.requested_at,
        attempts = j.attempts + 1,
        updated_at = now()
    from candidate
    where j.id = candidate.id
    returning j.id, j.organization_id, j.attempts
  `;
  return rows[0] ?? null;
}

async function claimAutomation() {
  const rows = await sql`
    with candidate as (
      select id from scheduled_automation
      where status in ('scheduled', 'pending')
        and due_at <= now()
        and (lease_until is null or lease_until < now())
      order by due_at, created_at
      for update skip locked
      limit 1
    )
    update scheduled_automation a
    set status = 'processing',
        lease_until = now() + interval '10 minutes',
        attempts = a.attempts + 1,
        updated_at = now()
    from candidate
    where a.id = candidate.id
    returning a.id, a.organization_id
  `;
  return rows[0] ?? null;
}

try {
  if (mode === "claim-agent-crash") {
    const job = await claimAgent();
    console.log(job?.id ?? "NONE");
  } else if (mode === "recover-agent") {
    const job = await claimAgent();
    if (job) {
      await sql`delete from durable_job where id = ${job.id} and organization_id = ${job.organization_id}`;
    }
    console.log(job?.id ?? "NONE");
  } else if (mode === "claim-automation-crash") {
    const job = await claimAutomation();
    console.log(job?.id ?? "NONE");
  } else if (mode === "recover-automation") {
    const job = await claimAutomation();
    if (job) {
      await sql`
        update scheduled_automation
        set status = 'completed', lease_until = null, completed_at = now(), updated_at = now()
        where id = ${job.id} and organization_id = ${job.organization_id}
      `;
    }
    console.log(job?.id ?? "NONE");
  } else if (mode === "dead-letter-agent") {
    const job = await claimAgent();
    if (job?.attempts >= 8) {
      await sql`
        update durable_job
        set lease_until = null, claimed_request_at = null,
            last_error = 'release gate poison job', dead_letter_at = now(), updated_at = now()
        where id = ${job.id} and organization_id = ${job.organization_id}
      `;
    }
    console.log(job?.id ?? "NONE");
  } else {
    process.exitCode = 2;
  }
} finally {
  await sql.end();
}
