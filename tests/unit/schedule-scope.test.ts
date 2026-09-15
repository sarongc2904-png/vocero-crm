import { describe, expect, it } from "vitest";
import { resolveScheduleScope } from "@/server/agenda/schedule-scope";

/**
 * Fase 1 — bug de rangos ("de lunes a domingo" devolvía solo lunes).
 * `resolveScheduleScope` es el clasificador que faltaba: decide el TIPO de
 * petición (fecha única / rango / general / próxima cita) ANTES de que
 * `resolveTargetDate` pueda colapsar un rango a la primera palabra de día
 * que encuentre.
 */

// Martes 15-sep-2026 05:00Z (23:00 del lunes 14 en America/Mexico_City — ver
// target-date.test.ts para la explicación completa de este ancla).
const NOW = new Date("2026-09-15T05:00:00.000Z");
const TZ = "America/Mexico_City";

describe("resolveScheduleScope — los 7 casos obligatorios del reporte", () => {
  it("'sábado' → single_date", () => {
    const scope = resolveScheduleScope("sábado", NOW, TZ);
    expect(scope).toEqual({ type: "single_date", date: "2026-09-19" });
  });

  it("'mañana' → single_date", () => {
    const scope = resolveScheduleScope("mañana", NOW, TZ);
    expect(scope).toEqual({ type: "single_date", date: "2026-09-15" });
  });

  it("'de lunes a domingo' → date_range (NO colapsa a 'lunes')", () => {
    // El "hoy" de este ancla (ver NOW arriba) es lunes 14-sep en la zona del
    // negocio — "lunes" resuelve a HOY (mismo criterio que target-date.test.ts:
    // "si hoy mismo es el día pedido, resuelve a hoy"), y "domingo" al que sigue.
    const scope = resolveScheduleScope("de lunes a domingo", NOW, TZ);
    expect(scope).toEqual({ type: "date_range", startDate: "2026-09-14", endDate: "2026-09-20" });
  });

  it("'esta semana' → date_range", () => {
    const scope = resolveScheduleScope("esta semana", NOW, TZ);
    expect(scope?.type).toBe("date_range");
    if (scope?.type !== "date_range") throw new Error("esperaba date_range");
    expect(scope.startDate).toBe("2026-09-14"); // hoy en la zona del negocio
    expect(scope.endDate).toBe("2026-09-20"); // domingo que sigue
  });

  it("'qué tienes esta semana' → date_range", () => {
    const scope = resolveScheduleScope("¿qué tienes esta semana?", NOW, TZ);
    expect(scope?.type).toBe("date_range");
  });

  it("'dame todos los horarios disponibles' → general_availability", () => {
    const scope = resolveScheduleScope("Dame todos los horarios disponibles", NOW, TZ);
    expect(scope).toEqual({ type: "general_availability" });
  });

  it("'cuál es la próxima cita disponible' → next_available", () => {
    const scope = resolveScheduleScope("¿Cuál es la próxima cita disponible?", NOW, TZ);
    expect(scope).toEqual({ type: "next_available" });
  });
});

describe("resolveScheduleScope — casos adicionales", () => {
  it("'de lunes a domingo' pedido un miércoles: rango claramente distinto de 'esta semana' (prueba que sí usa el rango, no el atajo de semana)", () => {
    // Miércoles 16-sep-2026, 18:00Z = mediodía local en America/Mexico_City.
    const miercoles = new Date("2026-09-16T18:00:00.000Z");
    const scope = resolveScheduleScope("de lunes a domingo", miercoles, TZ);
    expect(scope).toEqual({ type: "date_range", startDate: "2026-09-21", endDate: "2026-09-27" });
  });

  it("'de sábado a martes' cruza de semana: el fin no queda antes que el inicio", () => {
    const scope = resolveScheduleScope("de sábado a martes", NOW, TZ);
    expect(scope?.type).toBe("date_range");
    if (scope?.type !== "date_range") throw new Error("esperaba date_range");
    expect(scope.startDate).toBe("2026-09-19"); // sábado
    expect(scope.endDate >= scope.startDate).toBe(true);
    expect(scope.endDate).toBe("2026-09-22"); // martes de la semana siguiente
  });

  it("una pregunta que sí menciona un día concreto sigue siendo single_date, no general", () => {
    const scope = resolveScheduleScope("¿qué horarios tienes el sábado?", NOW, TZ);
    expect(scope).toEqual({ type: "single_date", date: "2026-09-19" });
  });

  it("sin ninguna señal de agenda → null", () => {
    expect(resolveScheduleScope("¿cuánto cuesta el corte?", NOW, TZ)).toBeNull();
  });
});
