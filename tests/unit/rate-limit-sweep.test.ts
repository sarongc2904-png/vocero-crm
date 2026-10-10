import { beforeEach, describe, expect, it } from "vitest";
import { checkRateLimit, resetRateLimit } from "@/lib/rate-limit";

// Estado interno del limitador (vive en globalThis para sobrevivir HMR).
const rl = globalThis as unknown as {
  __voceroRateLimit?: Map<string, number[]>;
  __voceroRateLimitExpiry?: Map<string, number>;
  __voceroRateLimitMaxWindow?: Map<string, number>;
  __voceroRateLimitNextExpiry?: number;
  __voceroRateLimitNextSweep?: number;
};

const SWEEP_INTERVAL_MS = 10_000;

function hasKey(key: string): boolean {
  return rl.__voceroRateLimit?.has(key) ?? false;
}

describe("rate limit: pasada de limpieza acotada a una cada 10 s", () => {
  beforeEach(() => resetRateLimit());

  it("los límites no cambian: 60 permitidas, la 61 negada, y tras la ventana vuelve a permitir", () => {
    const opts = { windowMs: 60_000, max: 60 };
    const t0 = 5_000_000;
    // Una clave corta que vence a mitad de camino fuerza pasadas intermedias.
    checkRateLimit("ruido", { windowMs: 1_000, max: 1 }, t0);
    for (let i = 0; i < 60; i++) {
      const r = checkRateLimit("ip:1", opts, t0 + i * 100);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(59 - i);
    }
    expect(checkRateLimit("ip:1", opts, t0 + 6_000).allowed).toBe(false);
    expect(checkRateLimit("ip:1", opts, t0 + 59_000).allowed).toBe(false);
    // La primera marca (t0) sale de la ventana en t0 + 60 000.
    expect(checkRateLimit("ip:1", opts, t0 + 60_001).allowed).toBe(true);
  });

  it("vence exactamente en el borde de la ventana", () => {
    const opts = { windowMs: 1_000, max: 1 };
    const t0 = 7_000_000;

    expect(checkRateLimit("borde", opts, t0)).toEqual({ allowed: true, remaining: 0 });
    expect(checkRateLimit("borde", opts, t0 + 999)).toEqual({
      allowed: false,
      remaining: 0,
    });
    expect(checkRateLimit("borde", opts, t0 + 1_000)).toEqual({
      allowed: true,
      remaining: 0,
    });
  });

  it("las claves vencidas se eliminan tras la ventana más el intervalo, y nunca antes de vencer", () => {
    const windowMs = 60_000;
    const t0 = 10_000_000;
    checkRateLimit("vieja", { windowMs, max: 5 }, t0);

    // Sondas de 1 s vencen sin parar: la primera pasada corre en t0 + 1 001 y
    // las siguientes cada 10 s (…, 51 001, 61 001), así que "vieja" sobrevive
    // a su propio vencimiento en t0 + 60 000 hasta la pasada de 61 001.
    let probe = 0;
    const tick = (now: number) =>
      checkRateLimit(`sonda:${probe++}`, { windowMs: 1_000, max: 5 }, now);

    for (let now = t0 + 1; now < t0 + windowMs; now += 1_000) {
      tick(now);
      expect(hasKey("vieja")).toBe(true);
    }
    tick(t0 + windowMs - 1);
    expect(hasKey("vieja")).toBe(true);

    tick(t0 + windowMs); // vencida, pero la pasada está acotada
    expect(rl.__voceroRateLimitNextSweep).toBe(t0 + windowMs + 1_001);
    expect(hasKey("vieja")).toBe(true);

    tick(t0 + windowMs + SWEEP_INTERVAL_MS);
    expect(hasKey("vieja")).toBe(false);
    expect(rl.__voceroRateLimitExpiry?.has("vieja")).toBe(false);
    expect(rl.__voceroRateLimitMaxWindow?.has("vieja")).toBe(false);
  });

  it("con 20 000 claves nuevas por segundo la pasada ocurre a lo sumo una vez cada 10 s", () => {
    const opts = { windowMs: 1_000, max: 3 };
    const t0 = 20_000_000;
    const seconds = 30;
    const perSecond = 20_000;
    const sweeps: number[] = [];
    let lastNextSweep = rl.__voceroRateLimitNextSweep;
    let maxSize = 0;

    for (let s = 0; s < seconds; s++) {
      for (let i = 0; i < perSecond; i++) {
        const now = t0 + s * 1_000 + Math.floor(i / 20);
        checkRateLimit(`k:${s}:${i}`, opts, now);
        const nextSweep = rl.__voceroRateLimitNextSweep;
        if (nextSweep !== lastNextSweep) {
          sweeps.push(now);
          lastNextSweep = nextSweep;
        }
      }
      maxSize = Math.max(maxSize, rl.__voceroRateLimit?.size ?? 0);
    }

    expect(sweeps.length).toBeGreaterThanOrEqual(2);
    expect(sweeps.length).toBeLessThanOrEqual(Math.ceil(seconds / 10));
    for (let j = 1; j < sweeps.length; j++) {
      expect(sweeps[j]! - sweeps[j - 1]!).toBeGreaterThanOrEqual(SWEEP_INTERVAL_MS);
    }
    // La memoria queda acotada por ventana + intervalo, no por el total visto.
    expect(maxSize).toBeLessThanOrEqual(perSecond * 12);
    expect(maxSize).toBeLessThan(perSecond * seconds);
  });

  it("resetRateLimit deja el estado limpio", () => {
    const opts = { windowMs: 1_000, max: 1 };
    const t0 = 30_000_000;
    checkRateLimit("a", opts, t0);
    checkRateLimit("b", opts, t0);
    checkRateLimit("c", opts, t0 + 2_000); // dispara una pasada
    expect(rl.__voceroRateLimitNextSweep).toBeDefined();
    expect(checkRateLimit("c", opts, t0 + 2_001).allowed).toBe(false);

    resetRateLimit();

    expect(rl.__voceroRateLimit?.size ?? 0).toBe(0);
    expect(rl.__voceroRateLimitExpiry?.size ?? 0).toBe(0);
    expect(rl.__voceroRateLimitMaxWindow?.size ?? 0).toBe(0);
    expect(rl.__voceroRateLimitNextExpiry).toBeUndefined();
    expect(rl.__voceroRateLimitNextSweep).toBeUndefined();
    // Sin pasada pendiente heredada y sin contadores previos.
    expect(checkRateLimit("c", opts, t0 + 2_002)).toEqual({
      allowed: true,
      remaining: 0,
    });
  });

  it("dos ventanas distintas en claves distintas no se interfieren", () => {
    const short = { windowMs: 1_000, max: 2 };
    const long = { windowMs: 60_000, max: 2 };
    const t0 = 40_000_000;
    checkRateLimit("corta", short, t0);
    checkRateLimit("corta", short, t0 + 1);
    checkRateLimit("larga", long, t0);
    checkRateLimit("larga", long, t0 + 1);
    expect(checkRateLimit("corta", short, t0 + 2).allowed).toBe(false);
    expect(checkRateLimit("larga", long, t0 + 2).allowed).toBe(false);

    // Vence la corta (y corre una pasada): la larga sigue bloqueada y presente.
    expect(checkRateLimit("corta", short, t0 + 1_500).allowed).toBe(true);
    expect(checkRateLimit("larga", long, t0 + 1_500).allowed).toBe(false);
    expect(hasKey("larga")).toBe(true);

    // Muy después, la corta se barre y la larga vuelve a permitir.
    expect(checkRateLimit("larga", long, t0 + 60_002).allowed).toBe(true);
    expect(checkRateLimit("otra", short, t0 + 60_002 + SWEEP_INTERVAL_MS).allowed).toBe(true);
    expect(hasKey("corta")).toBe(false);
    expect(hasKey("larga")).toBe(true);
  });

  it("una ventana corta no adelanta la expiración de un contador compartido con una ventana larga", () => {
    const long = { windowMs: 60_000, max: 2 };
    const short = { windowMs: 1_000, max: 2 };
    const t0 = 50_000_000;

    expect(checkRateLimit("compartida", long, t0)).toEqual({
      allowed: true,
      remaining: 1,
    });
    expect(checkRateLimit("compartida", short, t0 + 500)).toEqual({
      allowed: true,
      remaining: 0,
    });
    expect(rl.__voceroRateLimitMaxWindow?.get("compartida")).toBe(long.windowMs);
    expect(rl.__voceroRateLimitExpiry?.get("compartida")).toBe(t0 + 500 + long.windowMs);

    expect(checkRateLimit("compartida", long, t0 + 1_500)).toEqual({
      allowed: false,
      remaining: 0,
    });
  });
});
