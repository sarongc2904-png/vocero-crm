import { describe, expect, it } from "vitest";
import { businessHoursFact, resolveTargetDate } from "@/lib/time/target-date";

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

  it("'en la mañana' significa franja horaria, NO día siguiente", () => {
    expect(resolveTargetDate("¿tienen algo en la mañana?", NOW, TZ)).toBeNull();
    expect(resolveTargetDate("prefiero por la mañana", NOW, TZ)).toBeNull();
    expect(resolveTargetDate("a las 10 de la mañana", NOW, TZ)).toBeNull();
  });

  it("'mañana por la mañana' conserva mañana=día siguiente", () => {
    expect(resolveTargetDate("mañana por la mañana", NOW, TZ)?.iso).toBe("2026-09-15");
  });

  it("domingo (nombre de día, sin calificador)", () => {
    expect(resolveTargetDate("¿abren el domingo?", NOW, TZ)?.iso).toBe("2026-09-20");
  });

  it("sábado", () => {
    expect(resolveTargetDate("quiero cita el sábado", NOW, TZ)?.iso).toBe("2026-09-19");
  });

  it("este sábado / próximo sábado resuelven al mismo día", () => {
    expect(resolveTargetDate("este sábado", NOW, TZ)?.iso).toBe("2026-09-19");
    expect(resolveTargetDate("próximo sábado", NOW, TZ)?.iso).toBe("2026-09-19");
  });

  it("sin acentos y en mayúsculas también resuelve", () => {
    expect(resolveTargetDate("EL SABADO porfa", NOW, TZ)?.iso).toBe("2026-09-19");
  });

  it("si hoy mismo es el día pedido, resuelve a hoy", () => {
    expect(resolveTargetDate("¿tienen algo el martes?", NOW, TZ)?.iso).toBe("2026-09-15");
  });

  it("sin expresión reconocida → null; el backend no inventa fecha", () => {
    expect(resolveTargetDate("¿cuánto cuesta la consulta?", NOW, TZ)).toBeNull();
  });
});

describe("resolveTargetDate — fechas explícitas y calendario real", () => {
  it("YYYY-MM-DD explícita", () => {
    expect(resolveTargetDate("el 2026-10-03 si se puede", NOW, TZ)?.iso).toBe("2026-10-03");
  });

  it("DD/MM/YYYY", () => {
    expect(resolveTargetDate("para el 03/10/2026", NOW, TZ)?.iso).toBe("2026-10-03");
  });

  it("DD/MM sin año", () => {
    expect(resolveTargetDate("el 3/10 estaría bien", NOW, TZ)?.iso).toBe("2026-10-03");
  });

  it("DD de <mes>", () => {
    expect(resolveTargetDate("el 3 de octubre", NOW, TZ)?.iso).toBe("2026-10-03");
  });

  it("fecha sin año que ya pasó rueda al año siguiente", () => {
    expect(resolveTargetDate("el 20 de enero", NOW, TZ)?.iso).toBe("2027-01-20");
    expect(resolveTargetDate("el 20/01", NOW, TZ)?.iso).toBe("2027-01-20");
  });

  it("fecha con año explícito no rueda aunque ya haya pasado", () => {
    expect(resolveTargetDate("el 20 de enero de 2026", NOW, TZ)?.iso).toBe("2026-01-20");
  });

  it("rechaza días inexistentes en el calendario", () => {
    expect(resolveTargetDate("31/02/2026", NOW, TZ)).toBeNull();
    expect(resolveTargetDate("31 de abril de 2026", NOW, TZ)).toBeNull();
    expect(resolveTargetDate("2026-02-29", NOW, TZ)).toBeNull();
  });

  it("acepta 29 de febrero solo en año bisiesto", () => {
    expect(resolveTargetDate("29/02/2028", NOW, TZ)?.iso).toBe("2028-02-29");
  });
});

describe("resolveTargetDate — zona horaria", () => {
  it("respeta la zona del negocio, no UTC", () => {
    const lateUtc = new Date("2026-09-15T05:00:00.000Z");
    expect(resolveTargetDate("hoy", lateUtc, "America/Mexico_City")?.iso).toBe("2026-09-14");
    expect(resolveTargetDate("hoy", lateUtc, "UTC")?.iso).toBe("2026-09-15");
  });
});

describe("businessHoursFact — verdad del backend", () => {
  const weeklyHours = {
    sat: [{ start: "09:00", end: "17:00" }],
    sun: [{ start: "09:00", end: "17:00" }],
    mon: [{ start: "09:00", end: "18:00" }],
  };

  it("domingo configurado como abierto", () => {
    const fact = businessHoursFact("2026-09-20", weeklyHours, TZ);
    expect(fact.dayOfWeek).toBe("sun");
    expect(fact.businessOpen).toBe(true);
    expect(fact.businessHours).toBe("09:00-17:00");
  });

  it("día sin intervalos configurados → cerrado", () => {
    const fact = businessHoursFact("2026-09-16", weeklyHours, TZ);
    expect(fact.dayOfWeek).toBe("wed");
    expect(fact.businessOpen).toBe(false);
    expect(fact.businessHours).toBe("cerrado");
  });

  it("cambiar weeklyHours cambia inmediatamente la verdad", () => {
    const antes = businessHoursFact("2026-09-20", {}, TZ);
    expect(antes.businessOpen).toBe(false);

    const despues = businessHoursFact(
      "2026-09-20",
      { sun: [{ start: "10:00", end: "14:00" }] },
      TZ
    );
    expect(despues.businessOpen).toBe(true);
    expect(despues.businessHours).toBe("10:00-14:00");
  });
});
