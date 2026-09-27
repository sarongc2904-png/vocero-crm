import { execFileSync } from "node:child_process";

const inputBase = process.argv[2] ?? process.env.APP_BASE_URL ?? "http://127.0.0.1:3000";
const base = inputBase.replace(/\/$/, "");
const expectedCommit = (
  process.env.EXPECTED_COMMIT ??
  process.env.SOURCE_COMMIT ??
  localCommit()
).slice(0, 7);

let failures = 0;

function localCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function pass(label, detail = "") {
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label, detail = "") {
  failures += 1;
  console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function request(path, init = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${base}${path}`, {
      redirect: "manual",
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealth() {
  let lastError = null;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const res = await request("/api/health");
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw lastError ?? new Error("health endpoint no respondió");
}

async function main() {
  console.log(`Conecta Digital production smoke: ${base}`);

  let healthRes;
  try {
    healthRes = await waitForHealth();
    pass("/api/health responde 200");
  } catch (err) {
    fail("/api/health responde 200", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  let health;
  try {
    health = await healthRes.json();
  } catch {
    fail("/api/health devuelve JSON válido");
    process.exitCode = 1;
    return;
  }

  if (health?.ok === true) pass("base de datos disponible");
  else fail("base de datos disponible", JSON.stringify(health));

  if (typeof health?.version === "string" && health.version.length > 0) {
    pass("versión publicada", `v${health.version}`);
  } else {
    fail("versión publicada", "faltó health.version");
  }

  if (expectedCommit) {
    if (health?.commit === expectedCommit) {
      pass("commit desplegado coincide con el esperado", expectedCommit);
    } else {
      fail(
        "commit desplegado coincide con el esperado",
        `esperado=${expectedCommit}, desplegado=${health?.commit ?? "sin commit"}`
      );
    }
  } else if (health?.commit) {
    pass("commit desplegado expuesto", health.commit);
  } else {
    fail("commit desplegado expuesto", "SOURCE_COMMIT no llegó al build/runtime");
  }

  const unauth = await request("/api/settings/whatsapp");
  if ([401, 403, 302, 303, 307, 308].includes(unauth.status)) {
    pass("ajustes de WhatsApp protegidos sin sesión", `HTTP ${unauth.status}`);
  } else {
    fail("ajustes de WhatsApp protegidos sin sesión", `HTTP ${unauth.status}`);
  }

  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim();
  if (verifyToken) {
    const challenge = "conecta-digital-smoke";
    const qs = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": verifyToken,
      "hub.challenge": challenge,
    });
    const webhook = await request(
      `/api/webhooks/wa/${encodeURIComponent(verifyToken)}?${qs.toString()}`
    );
    const body = await webhook.text();
    if (webhook.status === 200 && body === challenge) {
      pass("handshake del webhook de WhatsApp");
    } else {
      fail(
        "handshake del webhook de WhatsApp",
        `HTTP ${webhook.status}, body=${JSON.stringify(body)}`
      );
    }
  } else {
    console.log("SKIP  handshake WhatsApp — META_WEBHOOK_VERIFY_TOKEN no está en el entorno del comando");
  }

  if (failures > 0) {
    console.error(`\nPRODUCTION SMOKE: FAIL (${failures})`);
    process.exitCode = 1;
    return;
  }

  console.log("\nPRODUCTION SMOKE: PASS");
}

await main();
