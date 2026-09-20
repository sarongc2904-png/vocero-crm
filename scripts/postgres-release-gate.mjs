import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL es obligatoria");

let passed = 0;
function ok(label, condition, detail = "") {
  assert.ok(condition, `${label}${detail ? `: ${detail}` : ""}`);
  passed += 1;
  console.log(`PASS ${String(passed).padStart(2, "0")} ${label}`);
}

function runWorker(mode) {
  const result = spawnSync(process.execPath, ["scripts/release-gate-worker.mjs", mode], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || `${mode} falló`);
  return result.stdout.trim().split(/\r?\n/).at(-1);
}

async function verifyUpgradePath() {
  const parsed = new URL(url);
  const database = `vocero_upgrade_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(parsed);
  adminUrl.pathname = "/postgres";
  const upgradeUrl = new URL(parsed);
  upgradeUrl.pathname = `/${database}`;
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  const temp = await mkdtemp(join(tmpdir(), "vocero-migrations-"));
  try {
    await admin.unsafe(`create database "${database}"`);
    await cp("drizzle", temp, { recursive: true });
    const journalPath = join(temp, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.entries = journal.entries.filter((entry) => entry.idx <= 20);
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    const partial = postgres(upgradeUrl.toString(), { max: 1, onnotice: () => {} });
    await migrate(drizzle(partial), { migrationsFolder: temp });
    await partial.end();

    const full = postgres(upgradeUrl.toString(), { max: 1, onnotice: () => {} });
    await migrate(drizzle(full), { migrationsFolder: "drizzle" });
    const rows = await full`select count(*)::int as count from drizzle.__drizzle_migrations`;
    ok("upgrade 0020 -> HEAD aplica las migraciones forward-only", rows[0].count === 26);
    await full.end();
  } finally {
    await admin.unsafe(`drop database if exists "${database}" with (force)`).catch(() => {});
    await admin.end();
    await rm(temp, { recursive: true, force: true });
  }
}

await verifyUpgradePath();

const sql = postgres(url, { max: 10, onnotice: () => {} });
const suffix = randomUUID().replaceAll("-", "");
const orgA = `org_gate_a_${suffix}`;
const orgB = `org_gate_b_${suffix}`;
const serviceA = `svc_gate_a_${suffix}`;
const professionalA = `pro_gate_a_${suffix}`;
const professionalA2 = `pro_gate_a2_${suffix}`;
const professionalB = `pro_gate_b_${suffix}`;
const contactA = `ct_gate_a_${suffix}`;
const conversationA = `cv_gate_a_${suffix}`;

try {
  const migrations = await sql`select count(*)::int as count from drizzle.__drizzle_migrations`;
  ok("base vacía contiene las 26 migraciones", migrations[0].count === 26);

  const requiredTables = await sql`
    select table_name from information_schema.tables
    where table_schema = 'public'
      and table_name in ('durable_job','scheduled_automation','organization_entitlement','service','professional')
  `;
  ok("tablas críticas presentes", requiredTables.length === 5);

  const exclusion = await sql`
    select conname from pg_constraint where conname = 'booking_professional_active_time_excl'
  `;
  ok("exclusion constraint de double booking presente", exclusion.length === 1);

  const legacyGuard = await sql`
    select tgname from pg_trigger
    where tgname = 'booking_legacy_active_time_guard' and not tgisinternal
  `;
  ok("guard concurrente de agenda legacy presente", legacyGuard.length === 1);

  const indexes = await sql`
    select indexname from pg_indexes
    where schemaname = 'public'
      and indexname in ('durable_job_due_idx','durable_job_lease_idx','scheduled_automation_due_idx')
  `;
  ok("índices de colas durables presentes", indexes.length === 3);

  await sql`insert into organization (id, name, slug) values (${orgA}, 'Gate A', ${orgA}), (${orgB}, 'Gate B', ${orgB})`;
  await sql`
    insert into service (id, organization_id, name, duration_minutes, price_cents)
    values (${serviceA}, ${orgA}, 'Servicio gate', 60, 10000)
  `;
  await sql`
    insert into professional (id, organization_id, name)
    values (${professionalA}, ${orgA}, 'Profesional A'),
           (${professionalA2}, ${orgA}, 'Profesional A2'),
           (${professionalB}, ${orgB}, 'Profesional B')
  `;

  const start = "2031-01-15T16:00:00.000Z";
  const insertBooking = (id, org, professional, at = start) => sql`
    insert into booking
      (id, organization_id, service_id, professional_id, scheduled_at, duration_minutes)
    values (${id}, ${org}, ${org === orgA ? serviceA : null}, ${professional}, ${at}, 60)
    returning id
  `;
  const race = await Promise.allSettled([
    insertBooking(`bk_race_1_${suffix}`, orgA, professionalA),
    insertBooking(`bk_race_2_${suffix}`, orgA, professionalA),
  ]);
  const fulfilled = race.filter((result) => result.status === "fulfilled");
  const rejected = race.filter((result) => result.status === "rejected");
  ok("dos conexiones simultáneas crean exactamente una cita", fulfilled.length === 1 && rejected.length === 1);
  ok("la colisión real es exclusion_violation", rejected[0]?.reason?.code === "23P01", rejected[0]?.reason?.code);

  const legacyRace = await Promise.allSettled([
    insertBooking(`bk_legacy_1_${suffix}`, orgA, null, "2031-01-16T16:00:00.000Z"),
    insertBooking(`bk_legacy_2_${suffix}`, orgA, null, "2031-01-16T16:00:00.000Z"),
  ]);
  ok(
    "agenda legacy serializa dos reservas simultáneas",
    legacyRace.filter((result) => result.status === "fulfilled").length === 1 &&
      legacyRace.filter((result) => result.status === "rejected").length === 1
  );
  ok(
    "agenda legacy devuelve exclusion_violation",
    legacyRace.find((result) => result.status === "rejected")?.reason?.code === "23P01"
  );

  await Promise.all([
    insertBooking(`bk_other_pro_${suffix}`, orgA, professionalA2),
    insertBooking(`bk_non_overlap_${suffix}`, orgA, professionalA, "2031-01-15T17:00:00.000Z"),
    insertBooking(`bk_other_tenant_${suffix}`, orgB, professionalB),
  ]);
  ok("profesional distinto, slot no superpuesto y tenant distinto coexisten", true);

  await sql`
    insert into contact (id, organization_id, wa_identity, name)
    values (${contactA}, ${orgA}, ${`gate:${suffix}`}, 'Contacto gate')
  `;
  await sql`
    insert into conversation (id, organization_id, contact_id)
    values (${conversationA}, ${orgA}, ${contactA})
  `;

  const jobId = `job_restart_${suffix}`;
  await sql`
    insert into durable_job (id, kind, organization_id, conversation_id, due_at)
    values (${jobId}, 'agent_turn', ${orgA}, ${conversationA}, now())
  `;
  ok("agent_turn persistido antes de caída", (await sql`select 1 from durable_job where id = ${jobId}`).length === 1);
  ok("primer proceso reclama agent_turn", runWorker("claim-agent-crash") === jobId);
  ok("caída deja job persistido con lease", (await sql`select 1 from durable_job where id = ${jobId} and lease_until > now()`).length === 1);
  await sql`update durable_job set lease_until = now() - interval '1 second' where id = ${jobId}`;
  ok("proceso nuevo recupera lease expirado", runWorker("recover-agent") === jobId);
  ok("agent_turn finaliza una sola vez", (await sql`select 1 from durable_job where id = ${jobId}`).length === 0 && runWorker("recover-agent") === "NONE");

  const automationId = `auto_restart_${suffix}`;
  await sql`
    insert into scheduled_automation
      (id, organization_id, kind, conversation_id, contact_id, due_at, idempotency_key)
    values (${automationId}, ${orgA}, 'follow_up', ${conversationA}, ${contactA}, now(), ${`follow:${suffix}`})
  `;
  ok("primer proceso reclama follow-up durable", runWorker("claim-automation-crash") === automationId);
  await sql`update scheduled_automation set lease_until = now() - interval '1 second', status = 'pending' where id = ${automationId}`;
  ok("proceso nuevo recupera y completa follow-up", runWorker("recover-automation") === automationId);
  const automation = await sql`select status, attempts from scheduled_automation where id = ${automationId}`;
  ok("follow-up queda completed y no vuelve a reclamarse", automation[0].status === "completed" && automation[0].attempts === 2 && runWorker("recover-automation") === "NONE");

  const duplicate = await Promise.allSettled([
    sql`insert into scheduled_automation (id, organization_id, kind, conversation_id, due_at, idempotency_key) values (${`auto_dup_1_${suffix}`}, ${orgA}, 'follow_up', ${conversationA}, now(), ${`duplicate:${suffix}`})`,
    sql`insert into scheduled_automation (id, organization_id, kind, conversation_id, due_at, idempotency_key) values (${`auto_dup_2_${suffix}`}, ${orgA}, 'follow_up', ${conversationA}, now(), ${`duplicate:${suffix}`})`,
  ]);
  ok("idempotencia de follow-up rechaza el duplicado", duplicate.filter((r) => r.status === "fulfilled").length === 1);

  const poisonId = `job_poison_${suffix}`;
  await sql`
    insert into durable_job (id, kind, organization_id, conversation_id, due_at, attempts)
    values (${poisonId}, 'agent_turn', ${orgA}, ${conversationA}, now(), 7)
  `;
  ok("poison job alcanza dead-letter sin loop", runWorker("dead-letter-agent") === poisonId);
  ok("dead-letter queda persistido e inreclamable", (await sql`select 1 from durable_job where id = ${poisonId} and dead_letter_at is not null and attempts = 8`).length === 1 && runWorker("recover-agent") === "NONE");

  console.log(`\nPOSTGRES RELEASE GATE: ${passed}/${passed} PASS`);
} finally {
  await sql`delete from organization where id in (${orgA}, ${orgB})`.catch(() => {});
  await sql.end();
}
