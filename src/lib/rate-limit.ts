/**
 * Limitación de tasa in-process por clave (IP) con ventana deslizante
 * (FR-062). Sin Redis (Constitución II): los contadores son locales al
 * proceso y NO se comparten entre réplicas; con varias réplicas el límite
 * efectivo se multiplica por el número de procesos.
 */

type Bucket = number[]; // timestamps (ms) de los intentos

const globalForRl = globalThis as unknown as {
  __voceroRateLimit?: Map<string, Bucket>;
  __voceroRateLimitExpiry?: Map<string, number>;
  __voceroRateLimitMaxWindow?: Map<string, number>;
  __voceroRateLimitNextExpiry?: number;
  __voceroRateLimitNextSweep?: number;
};

/** Intervalo mínimo entre pasadas completas de limpieza del almacén. */
const SWEEP_INTERVAL_MS = 10_000;

function store(): Map<string, Bucket> {
  if (!globalForRl.__voceroRateLimit) {
    globalForRl.__voceroRateLimit = new Map();
  }
  return globalForRl.__voceroRateLimit;
}

function expiryStore(): Map<string, number> {
  if (!globalForRl.__voceroRateLimitExpiry) {
    globalForRl.__voceroRateLimitExpiry = new Map();
  }
  return globalForRl.__voceroRateLimitExpiry;
}

function maxWindowStore(): Map<string, number> {
  if (!globalForRl.__voceroRateLimitMaxWindow) {
    globalForRl.__voceroRateLimitMaxWindow = new Map();
  }
  return globalForRl.__voceroRateLimitMaxWindow;
}

/**
 * Recorre el almacén solo cuando al menos una llave ya puede haber vencido, y a
 * lo sumo una vez cada SWEEP_INTERVAL_MS (acota el costo O(n) bajo ráfagas de
 * claves nuevas). Las entradas vencidas no afectan el límite: el filtro por
 * ventana de checkRateLimit las ignora hasta que la pasada las borre.
 */
function removeExpiredEntries(now: number): void {
  const nextExpiry = globalForRl.__voceroRateLimitNextExpiry;
  if (nextExpiry === undefined || now < nextExpiry) return;
  const nextSweep = globalForRl.__voceroRateLimitNextSweep;
  if (nextSweep !== undefined && now < nextSweep) return;
  globalForRl.__voceroRateLimitNextSweep = now + SWEEP_INTERVAL_MS;

  const buckets = store();
  const expiries = expiryStore();
  const maxWindows = maxWindowStore();
  let next: number | undefined;
  for (const [key, expiresAt] of expiries) {
    if (expiresAt <= now) {
      expiries.delete(key);
      buckets.delete(key);
      maxWindows.delete(key);
    } else if (next === undefined || expiresAt < next) {
      next = expiresAt;
    }
  }
  globalForRl.__voceroRateLimitNextExpiry = next;
}

function rememberExpiry(key: string, bucket: Bucket, windowMs: number): void {
  const last = bucket[bucket.length - 1];
  if (last === undefined) return;
  const windows = maxWindowStore();
  const maxWindowMs = Math.max(windows.get(key) ?? 0, windowMs);
  windows.set(key, maxWindowMs);
  const expiresAt = last + maxWindowMs;
  expiryStore().set(key, expiresAt);
  const next = globalForRl.__voceroRateLimitNextExpiry;
  if (next === undefined || expiresAt < next) {
    globalForRl.__voceroRateLimitNextExpiry = expiresAt;
  }
}

export type RateLimitResult = { allowed: boolean; remaining: number };

export function checkRateLimit(
  key: string,
  opts: { windowMs: number; max: number },
  now: number = Date.now()
): RateLimitResult {
  removeExpiredEntries(now);
  const buckets = store();
  const cutoff = now - opts.windowMs;
  const bucket = (buckets.get(key) ?? []).filter((t) => t > cutoff);

  if (bucket.length >= opts.max) {
    buckets.set(key, bucket);
    rememberExpiry(key, bucket, opts.windowMs);
    return { allowed: false, remaining: 0 };
  }
  bucket.push(now);
  buckets.set(key, bucket);
  rememberExpiry(key, bucket, opts.windowMs);
  return { allowed: true, remaining: opts.max - bucket.length };
}

/** Solo para tests. */
export function resetRateLimit(): void {
  store().clear();
  expiryStore().clear();
  maxWindowStore().clear();
  globalForRl.__voceroRateLimitNextExpiry = undefined;
  globalForRl.__voceroRateLimitNextSweep = undefined;
}

/** 10 intentos / 10 minutos por IP en login y registro (FR-062). */
export const AUTH_RATE_LIMIT = { windowMs: 10 * 60 * 1000, max: 10 };
