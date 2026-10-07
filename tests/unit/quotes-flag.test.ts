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
