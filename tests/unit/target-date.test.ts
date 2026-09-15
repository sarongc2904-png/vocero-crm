import { describe, expect, it } from "vitest";
import { businessHoursFact, resolveTargetDate } from "@/lib/time/target-date";

/**
 * Fase 1 — causa raíz del bug de agenda: `offer_slots.day` lo calculaba el
 * LLM desde lenguaje natural, sin verdad de negocio con qué contrastarlo.
 * `resolveTargetDate` es la fuente de verdad determinista que lo reemplaza —
 * estos son los tests obligatorios del gate `TARGET_DATE_SERVER_RESOLUTION`.
 */

// 2026-09-15T05:00:00Z son las 23:00 del LUNES 14 de septiembre en
// America/Mexico_City (UTC-6 en esa fecha) — el "hoy" de estos tests es el
// 14, no el 15: ver el describe de zona horaria más abajo, que ejercita
// justo esta diferencia a propósito.
const NOW = new Date("2026-09-15T05:00:00.000Z");
const TZ = "America/Mexico_City";

describe("resolveTargetDate — expresiones relativas", () => {
  it("hoy", () => {
    expect(resolveTargetDate("quiero una cita hoy", NOW, TZ)?.iso).toBe("2026-09-14");
  });

  it("mañana", () => {
    expect(resolveTargetDate("¿tienen algo mañana?", NOW, TZ)?.iso).toBe("2026-09-15");
  });

  it("pasado mañana (no se confunde con 'mañana')", () => {
    expect(resolveTargetDate("mejor pasado mañana", NOW, TZ)?.iso).toBe("2026-09-16");
  });

  it("domingo (nombre de día, sin calificador)", () => {
    // 15 sep 2026 es martes → el próximo domingo es el 20.
    expect(resolveTargetDate("¿abren el domingo?", NOW, TZ)?.iso).toBe("2026-09-20");
  });

  it("sábado", () => {
    expect(resolveTargetDate("quiero cita el sábado", NOW, TZ)?.iso).toBe("2026-09-19");
  });

  it("este sábado / próximo sábado resuelven al mismo día (ver nota del módulo)", () => {
    expect(resolveTargetDate("este sábado", NOW, TZ)?.iso).toBe("2026-09-19");
    expect(resolveTargetDate("próximo sábado", NOW, TZ)?.iso).toBe("2026-09-19");
  });

  it("sin acentos y en mayúsculas también resuelve (normalización)", () => {
    expect(resolveTargetDate("EL SABADO porfa", NOW, TZ)?.iso).toBe("2026-09-19");
  });

  it("si hoy mismo es el día pedido, resuelve a hoy (martes)", () => {
    expect(resolveTargetDate("¿tienen algo el martes?", NOW, TZ)?.iso).toBe("2026-09-15");
  });

  it("sin ninguna expresión reconocida → null (el day del modelo queda como único respaldo)", () => {
    expect(resolveTargetDate("¿cuánto cuesta la consulta?", NOW, TZ)).toBeNull();
  });
});

describe("resolveTargetDate — fechas explícitas y cambio de mes/año", () => {
  it("YYYY-MM-DD explícita", () => {
    expect(resolveTargetDate("el 2026-10-03 si se puede", NOW, TZ)?.iso).toBe("2026-10-03");
  });

  it("DD/MM/YYYY", () => {
    expect(resolveTargetDate("para el 03/10/2026", NOW, TZ)?.iso).toBe("2026-10-03");
  });

  it("DD/MM sin año, cruzando de septiembre a octubre (mismo año)", () => {
    expect(resolveTargetDate("el 3/10 estaría bien", NOW, TZ)?.iso).toBe("2026-10-03");
  });

  it("DD de <mes>", () => {
    expect(resolveTargetDate("el 3 de octubre", NOW, TZ)?.iso).toBe("2026-10-03");
  });

  it("DD/MM sin año que ya pasó este año → rueda al año siguiente", () => {
    // Desde el 15-sep-2026, "20 de enero" sin año ya pasó → 2027.
    expect(resolveTargetDate("el 20 de enero", NOW, TZ)?.iso).toBe("2027-01-20");
    expect(resolveTargetDate("el 20/01", NOW, TZ)?.iso).toBe("2027-01-20");
  });

  it("DD de <mes> de YYYY explícito no rueda de año aunque ya haya pasado", () => {
    expect(resolveTargetDate("el 20 de enero de 2026", NOW, TZ)?.iso).toBe("2026-01-20");
  });
});

describe("resolveTargetDate — zona horaria", () => {
  it("respeta la zona del negocio, no UTC: cerca de medianoche el día local puede ir un paso adelante o atrás", () => {
    // 2026-09-15T05:00:00Z son las 23:00 del 14-sep en America/Mexico_City
    // (UTC-6): "hoy" en la zona del negocio es el 14, no el 15.
    const lateUtc = new Date("2026-09-15T05:00:00.000Z");
    expect(resolveTargetDate("hoy", lateUtc, "America/Mexico_City")?.iso).toBe("2026-09-14");
    // La misma marca de tiempo, pero en UTC, sí cae en el 15.
    expect(resolveTargetDate("hoy", lateUtc, "UTC")?.iso).toBe("2026-09-15");
  });
});

describe("businessHoursFact — la verdad que se le da al LLM", () => {
  const weeklyHours = {
    sat: [{ start: "09:00", end: "17:00" }],
    sun: [{ start: "09:00", end: "17:00" }],
    mon: [{ start: "09:00", end: "18:00" }],
  };

  it("domingo configurado como abierto → businessOpen true, NUNCA 'cerrado'", () => {
    const fact = businessHoursFact("2026-09-20", weeklyHours, TZ); // domingo
    expect(fact.dayOfWeek).toBe("sun");
    expect(fact.businessOpen).toBe(true);
    expect(fact.businessHours).toBe("09:00-17:00");
  });

  it("un día sin intervalos configurados → cerrado", () => {
    const fact = businessHoursFact("2026-09-16", weeklyHours, TZ); // miércoles, sin horario
    expect(fact.dayOfWeek).toBe("wed");
    expect(fact.businessOpen).toBe(false);
    expect(fact.businessHours).toBe("cerrado");
  });

  it("cambiar `weeklyHours` (lo que vendría de Ajustes) cambia el resultado en la siguiente llamada — sin caché, sin redeploy", () => {
    const antes = businessHoursFact("2026-09-20", {}, TZ); // domingo sin horario aún
    expect(antes.businessOpen).toBe(false);

    // Simula que el dueño acaba de guardar Ajustes → Agenda con domingo abierto.
    const despues = businessHoursFact("2026-09-20", { sun: [{ start: "10:00", end: "14:00" }] }, TZ);
    expect(despues.businessOpen).toBe(true);
    expect(despues.businessHours).toBe("10:00-14:00");
  });
});
