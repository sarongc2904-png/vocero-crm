#!/usr/bin/env node
/**
 * Gate rápido previo a cada deploy: `pnpm test:mvp`.
 *
 * Solo verificaciones críticas y rápidas, sin red ni base de datos real
 * (todo lo que necesita Postgres vive en `test:release:postgres`):
 *   typecheck + tenant isolation + auth + contratos WhatsApp/IA/agenda +
 *   consistencia de migraciones.
 *
 * Si un archivo de la lista deja de existir el gate FALLA (no se salta en
 * silencio), para que renombrar un test no debilite la puerta sin que nadie
 * lo note.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const GROUPS = {
  "tenant isolation": [
    "tests/unit/tenant.test.ts",
    "tests/unit/tenant-security.test.ts",
    "tests/unit/tenant-ab-kb-agent.test.ts",
    "tests/unit/tenant-ab-core.test.ts",
    "tests/unit/tenant-ab-ai-agenda.test.ts",
    "tests/unit/phase2a-multitenant.test.ts",
    "tests/unit/critical-mutation-tenant-scope.test.ts",
    "tests/unit/beauty-tenant-scope.test.ts",
    "tests/unit/schedule-scope.test.ts",
    "tests/unit/stage-history-guard.test.ts",
  ],
  auth: [
    "tests/unit/auth-recovery.test.ts",
    "tests/unit/auth-session-state.test.ts",
    "tests/unit/registration.test.ts",
  ],
  "whatsapp contracts": [
    "tests/unit/webhook.test.ts",
    "tests/unit/meta-client.test.ts",
    "tests/unit/bot-gateway.test.ts",
  ],
  "ai contracts": [
    "tests/unit/agent-capability-guard.test.ts",
    "tests/unit/agent-contract-wave2.test.ts",
    "tests/unit/agent-response-contract.test.ts",
  ],
  "agenda contracts": [
    "tests/unit/agenda-contract.test.ts",
    "tests/unit/agenda-sandbox.test.ts",
  ],
  "db migrations": [
    "tests/unit/migration-journal.test.ts",
    "tests/unit/tenant-composite-fks.test.ts",
  ],
};

const files = Object.values(GROUPS).flat();
const missing = files.filter((f) => !existsSync(f));
if (missing.length > 0) {
  console.error("[test:mvp] FALTAN archivos del gate:\n  " + missing.join("\n  "));
  process.exit(1);
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
function run(label, args) {
  console.log(`\n[test:mvp] ▶ ${label}`);
  const r = spawnSync(pnpm, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) {
    console.error(`\n[test:mvp] ✖ falló: ${label}`);
    process.exit(r.status ?? 1);
  }
}

run("typecheck", ["typecheck"]);
run(`vitest (${Object.keys(GROUPS).join(", ")})`, [
  "vitest",
  "run",
  // El primer test de cada archivo paga el import en frío del pipeline; con 5 s
  // da falsos rojos en runners lentos. Solo afecta a este gate.
  "--testTimeout=30000",
  ...files,
]);
console.log("\n[test:mvp] ✔ gate rápido OK");
