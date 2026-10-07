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

function runWorkerJson(mode) {
  const output = runWorker(mode);
  assert.notEqual(output, "NONE", `${mode} no reclamó ningún job`);
  return JSON.parse(output);
}

/**
 * Suites de Vitest que necesitan un Postgres real. En `pnpm test` se omiten
 * (no hay `VOCERO_TEST_PG_URL`); aquí corren contra la misma base del gate y
 * el gate FALLA si alguna prueba se omite, falla o desaparece. `minTests` es
 * un piso: borrar casos de aislamiento también rompe el gate.
 */
const PG_VITEST_SUITES = [
  { file: "tests/unit/quotes-tenant-isolation-postgres.test.ts", minTests: 13 },
  { file: "tests/unit/quotes-bot-api-postgres.test.ts", minTests: 13 },
  { file: "tests/unit/quotes-public-postgres.test.ts", minTests: 11 },
  { file: "tests/unit/quotes-transitions-postgres.test.ts", minTests: 44 },
  { file: "tests/unit/quotes-crm-postgres.test.ts", minTests: 13 },
  { file: "tests/unit/quotes-whatsapp-send-postgres.test.ts", minTests: 22 },
  { file: "tests/unit/quotes-settings-postgres.test.ts", minTests: 6 },
];

async function runPgVitestSuites() {
  const outDir = await mkdtemp(join(tmpdir(), "vocero-pg-vitest-"));
  try {
    for (const suite of PG_VITEST_SUITES) {
      const report = join(outDir, "report.json");
      const result = spawnSync(
        process.execPath,
        ["node_modules/vitest/vitest.mjs", "run", suite.file, "--reporter=json", `--outputFile=${report}`],
        {
          cwd: process.cwd(),
          env: { ...process.env, VOCERO_TEST_PG_URL: url },
          encoding: "utf8",
        }
      );
      let parsed = null;
      try {
        parsed = JSON.parse(await readFile(report, "utf8"));
      } catch {
        // Sin reporte: el detalle va en stderr.
      }
      const detail = parsed
        ? `total=${parsed.numTotalTests} pasaron=${parsed.numPassedTests} fallaron=${parsed.numFailedTests} omitidas=${parsed.numPendingTests + parsed.numTodoTests}`
        : (result.stderr || result.stdout).slice(-2000);
      ok(
        `vitest con Postgres real: ${suite.file}`,
        result.status === 0 &&
          parsed !== null &&
          parsed.numFailedTests === 0 &&
          parsed.numPendingTests === 0 &&
          parsed.numTodoTests === 0 &&
          parsed.numPassedTests === parsed.numTotalTests &&
          parsed.numTotalTests >= suite.minTests,
        detail
      );
      await rm(report, { force: true });
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
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
    const expectedMigrationCount = journal.entries.length;
    journal.entries = journal.entries.filter((entry) => entry.idx <= 20);
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    const partial = postgres(upgradeUrl.toString(), { max: 1, onnotice: () => {} });
    await migrate(drizzle(partial), { migrationsFolder: temp });
    await partial.end();

    const full = postgres(upgradeUrl.toString(), { max: 1, onnotice: () => {} });
    await migrate(drizzle(full), { migrationsFolder: "drizzle" });
    const rows = await full`select count(*)::int as count from drizzle.__drizzle_migrations`;
    ok(
      "upgrade 0020 -> HEAD aplica las migraciones forward-only",
      rows[0].count === expectedMigrationCount,
      `esperadas=${expectedMigrationCount}, reales=${rows[0].count}`
    );
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
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
  const expectedMigrationCount = journal.entries.length;
  const migrations = await sql`select count(*)::int as count from drizzle.__drizzle_migrations`;
  ok(
    `base vacía contiene las ${expectedMigrationCount} migraciones`,
    migrations[0].count === expectedMigrationCount,
    `reales=${migrations[0].count}`
  );

  const requiredTables = await sql`
    select table_name from information_schema.tables
    where table_schema = 'public'
      and table_name in (
        'durable_job','scheduled_automation','organization_entitlement','service','professional',
        'agent_run','agent_action_event','agent_evidence','agent_test_evidence_snapshot'
      )
  `;
  ok("tablas críticas presentes", requiredTables.length === 9);

  const tenantFkGaps = await sql`
    with simple_tenant_fks as (
      select
        fk.conrelid,
        fk.confrelid,
        child.relname as child_table,
        parent.relname as parent_table,
        child_column.attname::text as child_column
      from pg_constraint fk
      join pg_class child on child.oid = fk.conrelid
      join pg_class parent on parent.oid = fk.confrelid
      join pg_namespace child_namespace on child_namespace.oid = child.relnamespace
      join pg_namespace parent_namespace on parent_namespace.oid = parent.relnamespace
      join lateral unnest(fk.conkey, fk.confkey) with ordinality
        as key_pair(child_attnum, parent_attnum, position)
        on key_pair.position = 1
      join pg_attribute child_column
        on child_column.attrelid = fk.conrelid
       and child_column.attnum = key_pair.child_attnum
      join pg_attribute parent_column
        on parent_column.attrelid = fk.confrelid
       and parent_column.attnum = key_pair.parent_attnum
      where fk.contype = 'f'
        and array_length(fk.conkey, 1) = 1
        and child_namespace.nspname = 'public'
        and parent_namespace.nspname = 'public'
        and parent_column.attname = 'id'
        and exists (
          select 1 from pg_attribute organization_column
          where organization_column.attrelid = child.oid
            and organization_column.attname = 'organization_id'
            and not organization_column.attisdropped
        )
        and exists (
          select 1 from pg_attribute organization_column
          where organization_column.attrelid = parent.oid
            and organization_column.attname = 'organization_id'
            and not organization_column.attisdropped
        )
    )
    select child_table, child_column, parent_table
    from simple_tenant_fks simple
    where not exists (
      select 1
      from pg_constraint candidate
      where candidate.contype = 'f'
        and candidate.conrelid = simple.conrelid
        and candidate.confrelid = simple.confrelid
        and array(
          select attribute.attname::text
          from unnest(candidate.conkey) with ordinality key(attnum, position)
          join pg_attribute attribute
            on attribute.attrelid = candidate.conrelid
           and attribute.attnum = key.attnum
          order by key.position
        ) = array['organization_id', simple.child_column]
        and array(
          select attribute.attname::text
          from unnest(candidate.confkey) with ordinality key(attnum, position)
          join pg_attribute attribute
            on attribute.attrelid = candidate.confrelid
           and attribute.attnum = key.attnum
          order by key.position
        ) = array['organization_id', 'id']
        and candidate.convalidated
    )
    order by child_table, child_column
  `;
  ok(
    "todas las FKs entre tablas tenant-aware tienen respaldo compuesto validado",
    tenantFkGaps.length === 0,
    tenantFkGaps
      .map((row) => `${row.child_table}.${row.child_column}->${row.parent_table}`)
      .join(", ")
  );

  const exclusion = await sql`
    select conname, pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid = 'booking'::regclass and contype = 'x'
  `;
  ok("exclusion constraint de double booking presente", exclusion.length >= 1);
  // SEC-V2: la protección anti doble-reserva debe ser POR TENANT. La versión de
  // la 0021 indexaba solo (professional_id, rango): con la FK global, un id
  // ajeno acoplaba la agenda de dos organizaciones.
  ok(
    "la exclusion constraint incluye organization_id (aislamiento por tenant)",
    exclusion.some((row) => String(row.def).includes("organization_id")),
    exclusion.map((row) => row.conname).join(", ")
  );
  ok(
    "la constraint previa sin organización ya no existe",
    !exclusion.some(
      (row) => row.conname === "booking_professional_active_time_excl"
    )
  );

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

  // La FK compuesta debe rechazar la combinación orgB + professionalA(orgA)
  // antes de que la exclusion constraint evalúe el rango.
  await insertBooking(
    `bk_same_pro_a_${suffix}`,
    orgA,
    professionalA,
    "2031-01-20T16:00:00.000Z"
  );
  const crossTenant = await Promise.allSettled([
    insertBooking(
      `bk_cross_tenant_professional_fk_${suffix}`,
      orgB,
      professionalA,
      "2031-01-20T16:00:00.000Z"
    ),
  ]);
  ok(
    "booking cross-tenant es rechazado por FK",
    crossTenant[0]?.status === "rejected" &&
      crossTenant[0]?.reason?.code === "23503",
    crossTenant[0]?.status === "rejected"
      ? crossTenant[0]?.reason?.code
      : "fulfilled"
  );
  await insertBooking(
    `bk_same_range_org_b_${suffix}`,
    orgB,
    professionalB,
    "2031-01-20T16:00:00.000Z"
  );
  ok("dos tenants con profesionales propios usan el mismo rango sin interferirse", true);

  await sql`
    insert into contact (id, organization_id, wa_identity, name)
    values (${contactA}, ${orgA}, ${`gate:${suffix}`}, 'Contacto gate')
  `;
  await sql`
    insert into conversation (id, organization_id, contact_id)
    values (${conversationA}, ${orgA}, ${contactA})
  `;

  const observableRunId = `agent_run_${suffix}`;
  await sql`
    insert into agent_run (id, organization_id, conversation_id, trace_id)
    values (${observableRunId}, ${orgA}, ${conversationA}, ${`trace_${suffix}`})
  `;
  const crossTenantAction = await Promise.allSettled([
    sql`insert into agent_action_event
      (id, organization_id, run_id, action, success, status)
      values (${`action_cross_${suffix}`}, ${orgB}, ${observableRunId}, 'reply', true, 'completed')`,
  ]);
  ok(
    "run A no acepta action event de org B",
    crossTenantAction[0]?.status === "rejected" &&
      crossTenantAction[0]?.reason?.code === "23503",
    crossTenantAction[0]?.status === "rejected"
      ? crossTenantAction[0]?.reason?.code
      : "fulfilled"
  );
  const crossTenantEvidence = await Promise.allSettled([
    sql`insert into agent_evidence
      (id, organization_id, run_id, source_type, snapshot, content_hash, ordinal)
      values (${`evidence_cross_${suffix}`}, ${orgB}, ${observableRunId},
        'conversation_context', '{}'::jsonb, 'digest', 0)`,
  ]);
  ok(
    "run A no acepta evidence de org B",
    crossTenantEvidence[0]?.status === "rejected" &&
      crossTenantEvidence[0]?.reason?.code === "23503",
    crossTenantEvidence[0]?.status === "rejected"
      ? crossTenantEvidence[0]?.reason?.code
      : "fulfilled"
  );

  const labRunId = `lab_run_fk_${suffix}`;
  const labCaseId = `lab_case_fk_${suffix}`;
  await sql`insert into agent_test_run (id, organization_id, status) values (${labRunId}, ${orgA}, 'done')`;
  await sql`insert into agent_test_case (id, organization_id, run_id, persona) values (${labCaseId}, ${orgA}, ${labRunId}, 'fk_gate')`;
  const crossTenantSnapshot = await Promise.allSettled([
    sql`insert into agent_test_evidence_snapshot
      (id, organization_id, test_case_id, evidence, evidence_digest)
      values (${`snapshot_cross_${suffix}`}, ${orgB}, ${labCaseId}, '{}'::jsonb, 'digest')`,
  ]);
  ok(
    "test_case A no acepta snapshot de org B",
    crossTenantSnapshot[0]?.status === "rejected" &&
      crossTenantSnapshot[0]?.reason?.code === "23503",
    crossTenantSnapshot[0]?.status === "rejected"
      ? crossTenantSnapshot[0]?.reason?.code
      : "fulfilled"
  );

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

  const ownershipJobId = `job_ownership_${suffix}`;
  await sql`
    insert into durable_job (id, kind, organization_id, conversation_id, due_at)
    values (${ownershipJobId}, 'agent_turn', ${orgA}, ${conversationA}, now())
  `;
  const workerA = runWorkerJson("claim-agent-with-token");
  ok(
    "worker A reclama durable_job con ownership",
    workerA.id === ownershipJobId && Boolean(workerA.lease_token)
  );
  await sql`
    update durable_job
    set lease_until = '-infinity'::timestamp,
        due_at = least(due_at, now())
    where id = ${ownershipJobId}
  `;
  const workerB = runWorkerJson("claim-agent-with-token");
  ok(
    "worker B recupera el mismo durable_job",
    workerB.id === ownershipJobId && Boolean(workerB.lease_token)
  );
  ok(
    "cada reclamación recibe un lease_token distinto",
    workerA.lease_token !== workerB.lease_token
  );

  const staleDelete = await sql`
    delete from durable_job
    where id = ${ownershipJobId}
      and organization_id = ${orgA}
      and lease_token = ${workerA.lease_token}
    returning id
  `;
  const ownedByB = await sql`
    select lease_token, lease_until::text, due_at::text, dead_letter_at
    from durable_job
    where id = ${ownershipJobId}
  `;
  ok(
    "worker A stale no puede borrar el job de B",
    staleDelete.length === 0 &&
      ownedByB.length === 1 &&
      ownedByB[0].lease_token === workerB.lease_token
  );

  const staleRetry = await sql`
    update durable_job
    set lease_until = null,
        lease_token = null,
        claimed_request_at = null,
        due_at = now() + interval '5 seconds',
        last_error = 'stale retry',
        updated_at = now()
    where id = ${ownershipJobId}
      and organization_id = ${orgA}
      and lease_token = ${workerA.lease_token}
    returning id
  `;
  const afterStaleRetry = await sql`
    select lease_token, lease_until::text, due_at::text, dead_letter_at
    from durable_job
    where id = ${ownershipJobId}
  `;
  ok(
    "worker A stale no puede liberar ni reprogramar el job de B",
    staleRetry.length === 0 &&
      afterStaleRetry[0].lease_token === workerB.lease_token &&
      afterStaleRetry[0].lease_until === ownedByB[0].lease_until &&
      afterStaleRetry[0].due_at === ownedByB[0].due_at
  );

  const staleDeadLetter = await sql`
    update durable_job
    set lease_until = null,
        lease_token = null,
        claimed_request_at = null,
        dead_letter_at = now(),
        last_error = 'stale dead-letter',
        updated_at = now()
    where id = ${ownershipJobId}
      and organization_id = ${orgA}
      and lease_token = ${workerA.lease_token}
    returning id
  `;
  const afterStaleDeadLetter = await sql`
    select lease_token, dead_letter_at
    from durable_job
    where id = ${ownershipJobId}
  `;
  ok(
    "worker A stale no puede mandar el job de B a dead-letter",
    staleDeadLetter.length === 0 &&
      afterStaleDeadLetter[0].lease_token === workerB.lease_token &&
      afterStaleDeadLetter[0].dead_letter_at === null
  );

  const ownerDelete = await sql`
    delete from durable_job
    where id = ${ownershipJobId}
      and organization_id = ${orgA}
      and lease_token = ${workerB.lease_token}
    returning id
  `;
  ok(
    "worker B completa con su lease_token y elimina la fila",
    ownerDelete.length === 1 &&
      (await sql`select 1 from durable_job where id = ${ownershipJobId}`).length === 0
  );

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
    values (${poisonId}, 'agent_turn', ${orgA}, ${conversationA}, '-infinity'::timestamp, 7)
  `;
  ok("poison job alcanza dead-letter sin loop", runWorker("dead-letter-agent") === poisonId);
  ok("dead-letter queda persistido e inreclamable", (await sql`select 1 from durable_job where id = ${poisonId} and dead_letter_at is not null and attempts = 8`).length === 1 && runWorker("recover-agent") === "NONE");

  // 0037 — cotizaciones: tablas presentes y aislamiento por negocio.
  const quoteTables = await sql`
    select table_name from information_schema.tables
    where table_schema = 'public'
      and table_name in ('quote','quote_item','quote_link','quote_counter','quote_settings')
  `;
  ok("tablas de cotizaciones presentes", quoteTables.length === 5, `reales=${quoteTables.length}`);
  await runPgVitestSuites();

  console.log(`\nPOSTGRES RELEASE GATE: ${passed}/${passed} PASS`);
} finally {
  await sql`delete from organization where id in (${orgA}, ${orgB})`.catch(() => {});
  await sql.end();
}
