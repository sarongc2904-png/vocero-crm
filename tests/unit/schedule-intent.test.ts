import { describe, expect, it } from "vitest";
import {
  capitalize,
  factualHoursReply,
  formatHoursEs,
  resolveScheduleIntent,
} from "@/server/agenda/schedule-intent";

/**
 * Fase 1 — corrección a la regresión de domingo. `resolveScheduleIntent` es
 * el guardarraíl determinista: dado un mensaje, decide targetDate/businessOpen
 * /businessHours/requiresAvailabilityLookup ANTES de que el texto del modelo
 * importe. Estos son tests puros — la integración con `runAgentTurn` vive en
 * `agenda-schedule-guardrail-e2e.test.ts`.
 */

// Mismo ancla que el resto de la suite de agenda: martes 15-sep-2026 05:00Z
// (23:00 del lunes 14 en America/Mexico_City — ver target-date.test.ts).
const NOW = new Date("2026-09-15T05:00:00.000Z");
const TZ = "America/Mexico_City";

const ABIERTO_TODA_LA_SEMANA = {
  mon: [{ start: "09:00", end: "17:00" }],
  tue: [{ start: "09:00", end: "17:00" }],
  wed: [{ start: "09:00", end: "17:00" }],
  thu: [{ start: "09:00", end: "17:00" }],
  fri: [{ start: "09:00", end: "17:00" }],
  sat: [{ start: "09:00", end: "17:00" }],
  sun: [{ start: "09:00", end: "17:00" }],
};

const SOLO_ENTRE_SEMANA = {
  mon: [{ start: "09:00", end: "17:00" }],
  tue: [{ start: "09:00", end: "17:00" }],
  wed: [{ start: "09:00", end: "17:00" }],
  thu: [{ start: "09:00", end: "17:00" }],
  fri: [{ start: "09:00", end: "17:00" }],
  // sábado y domingo AUSENTES a propósito: negocio realmente cerrado esos días.
};

describe("resolveScheduleIntent — sin fecha en el mensaje", () => {
  it("mensaje sin ninguna expresión de fecha → kind 'none'", () => {
    const intent = resolveScheduleIntent({
      text: "¿cuánto cuesta el corte de caballero?",
      now: NOW,
      weeklyHours: ABIERTO_TODA_LA_SEMANA,
      timezone: TZ,
    });
    expect(intent.kind).toBe("none");
  });
});

describe("resolveScheduleIntent — Caso 1: negocio cerrado ese día", () => {
  it("domingo realmente cerrado → businessOpen false, businessHours 'cerrado'", () => {
    const intent = resolveScheduleIntent({
      text: "Domingo",
      now: NOW,
      weeklyHours: SOLO_ENTRE_SEMANA,
      timezone: TZ,
    });
    expect(intent.kind).toBe("date_mentioned");
    if (intent.kind !== "date_mentioned") return;
    expect(intent.targetDate).toBe("2026-09-20");
    expect(intent.businessOpen).toBe(false);
    expect(intent.businessHours).toBe("cerrado");
  });

  it("factualHoursReply del cerrado dice 'estamos cerrados', con fecha, nunca la palabra 'abrimos'", () => {
    const intent = resolveScheduleIntent({
      text: "¿abren domingo?",
      now: NOW,
      weeklyHours: SOLO_ENTRE_SEMANA,
      timezone: TZ,
    });
    if (intent.kind !== "date_mentioned") throw new Error("debía reconocer domingo");
    const texto = factualHoursReply(intent);
    expect(texto).toMatch(/estamos cerrados/i);
    expect(texto).toContain("20 de septiembre");
    expect(texto).not.toMatch(/abrimos/i);
  });
});

describe("resolveScheduleIntent — Caso 2: abierto, solo pregunta horario (sin pedir ver huecos)", () => {
  it("'¿abren domingo?' con domingo abierto → requiresAvailabilityLookup false", () => {
    const intent = resolveScheduleIntent({
      text: "¿abren domingo?",
      now: NOW,
      weeklyHours: ABIERTO_TODA_LA_SEMANA,
      timezone: TZ,
    });
    expect(intent.kind).toBe("date_mentioned");
    if (intent.kind !== "date_mentioned") return;
    expect(intent.businessOpen).toBe(true);
    expect(intent.requiresAvailabilityLookup).toBe(false);
  });

  it("factualHoursReply del abierto dice 'Sí, ... abrimos de HH:MM a HH:MM.'", () => {
    const intent = resolveScheduleIntent({
      text: "¿qué horario tienen el domingo?",
      now: NOW,
      weeklyHours: ABIERTO_TODA_LA_SEMANA,
      timezone: TZ,
    });
    if (intent.kind !== "date_mentioned") throw new Error("debía reconocer domingo");
    const texto = factualHoursReply(intent);
    expect(texto).toMatch(/^Sí, .*abrimos de 09:00 a 17:00\.$/);
    expect(texto).not.toMatch(/cerrad/i);
  });

  it("una pregunta que SÍ pide agendar, aunque mencione 'horario', exige disponibilidad real", () => {
    const intent = resolveScheduleIntent({
      text: "quiero ver los horarios disponibles del domingo para agendar",
      now: NOW,
      weeklyHours: ABIERTO_TODA_LA_SEMANA,
      timezone: TZ,
    });
    if (intent.kind !== "date_mentioned") throw new Error("debía reconocer domingo");
    expect(intent.requiresAvailabilityLookup).toBe(true);
  });
});

describe("resolveScheduleIntent — 'Domingo' a secas (el caso exacto que falló en producción)", () => {
  it("sin ninguna palabra clave → por defecto SÍ requiere disponibilidad (nunca un 'sí/no' que pueda sonar a 'cerrado')", () => {
    const intent = resolveScheduleIntent({
      text: "Domingo",
      now: NOW,
      weeklyHours: ABIERTO_TODA_LA_SEMANA,
      timezone: TZ,
    });
    if (intent.kind !== "date_mentioned") throw new Error("debía reconocer domingo");
    expect(intent.requiresAvailabilityLookup).toBe(true);
    expect(intent.businessOpen).toBe(true);
  });

  it("'Mejor domingo' (la frase real del bug reportado) resuelve domingo, abierto, y pide disponibilidad", () => {
    const intent = resolveScheduleIntent({
      text: "Mejor domingo",
      now: NOW,
      weeklyHours: ABIERTO_TODA_LA_SEMANA,
      timezone: TZ,
    });
    if (intent.kind !== "date_mentioned") throw new Error("debía reconocer domingo");
    expect(intent.targetDate).toBe("2026-09-20");
    expect(intent.businessOpen).toBe(true);
    expect(intent.requiresAvailabilityLookup).toBe(true);
  });
});

describe("formatHoursEs / capitalize", () => {
  it("formatea un intervalo", () => {
    expect(formatHoursEs("09:00-17:00")).toBe("09:00 a 17:00");
  });
  it("formatea varios intervalos separados por coma", () => {
    expect(formatHoursEs("09:00-13:00, 15:00-18:00")).toBe("09:00 a 13:00, 15:00 a 18:00");
  });
  it("capitaliza solo la primera letra", () => {
    expect(capitalize("domingo, 20 de septiembre")).toBe("Domingo, 20 de septiembre");
  });
});
