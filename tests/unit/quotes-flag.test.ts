import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseCotizacionesFlag,
  quotesDisabledResponse,
  quotesEnabled,
} from "@/server/quotes/flag";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("bandera COTIZACIONES", () => {
  it("está apagada por defecto", () => {
    vi.stubEnv("COTIZACIONES", undefined);
    expect(quotesEnabled()).toBe(false);
  });

  it("solo se enciende con valores explícitos", () => {
    for (const on of ["on", "ON", " 1 ", "true", "si", "sí", "yes"]) {
      expect(parseCotizacionesFlag(on), on).toBe(true);
    }
    for (const off of ["", "off", "0", "false", "no", "cotizaciones", undefined]) {
      expect(parseCotizacionesFlag(off), String(off)).toBe(false);
    }
  });

  it("lee el entorno en cada llamada", () => {
    vi.stubEnv("COTIZACIONES", "on");
    expect(quotesEnabled()).toBe(true);
    vi.stubEnv("COTIZACIONES", "off");
    expect(quotesEnabled()).toBe(false);
  });

  it("apagada responde 404 sin cuerpo", async () => {
    const res = quotesDisabledResponse();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });
});

/**
 * El servicio `app` de docker-compose.yml lista sus variables a mano: si
 * COTIZACIONES no está ahí, la bandera del .env nunca llega al contenedor.
 */
describe("COTIZACIONES llega al contenedor de la app", () => {
  function appEnvironment(): string[] {
    const lines = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8").split(/\r?\n/);
    const app = lines.findIndex((line) => /^ {2}app:\s*$/.test(line));
    expect(app, "servicio app").toBeGreaterThanOrEqual(0);
    const env = lines.findIndex((line, i) => i > app && /^ {4}environment:\s*$/.test(line));
    expect(env, "environment del servicio app").toBeGreaterThan(app);
    const block: string[] = [];
    for (const line of lines.slice(env + 1)) {
      if (!/^ {6}\S/.test(line)) break;
      block.push(line.trim());
    }
    return block;
  }

  it("el servicio app declara COTIZACIONES, apagada por defecto", () => {
    const entry = appEnvironment().find((line) => line.startsWith("COTIZACIONES:"));
    expect(entry).toBe("COTIZACIONES: ${COTIZACIONES:-off}");
    // El valor por defecto del compose cuenta como apagado.
    expect(parseCotizacionesFlag("off")).toBe(false);
  });
});
