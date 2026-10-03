import { describe, expect, it } from "vitest";
import { analyzeScheduleCoherence } from "@/server/commercial/schedule-coherence";

const weekdays = {
  mon: [{ start: "09:00", end: "18:00" }],
  tue: [{ start: "09:00", end: "18:00" }],
  wed: [{ start: "09:00", end: "18:00" }],
  thu: [{ start: "09:00", end: "18:00" }],
  fri: [{ start: "09:00", end: "18:00" }],
};

describe("coherencia determinista agenda/documento", () => {
  it("advierte cuando el documento abre sábado y la agenda está cerrada", () => {
    const result = analyzeScheduleCoherence({
      weeklyHours: weekdays,
      maxDaysAhead: 14,
      documentText: "Atendemos sábado de 9:00 a 14:00.",
    });
    expect(result.status).toBe("differences");
    expect(result.differences).toContainEqual(
      expect.objectContaining({ day: "Sábado", agenda: "cerrado" })
    );
  });

  it("advierte cuando el documento dice L-V hasta 19:00 y la agenda hasta 18:00", () => {
    const result = analyzeScheduleCoherence({
      weeklyHours: weekdays,
      maxDaysAhead: 14,
      documentText: "Nuestro horario es L-V hasta las 19:00.",
    });
    expect(result.status).toBe("differences");
    expect(result.differences).toHaveLength(5);
  });

  it("no inventa horarios cuando el documento no los menciona", () => {
    const result = analyzeScheduleCoherence({
      weeklyHours: weekdays,
      maxDaysAhead: 14,
      documentText: "Ofrecemos valoración y seguimiento personalizado.",
    });
    expect(result.status).toBe("unverifiable");
    expect(result.message).toContain("No se pudo verificar");
  });

  it("advierte cuando la agenda abierta es menor a 14 días", () => {
    const result = analyzeScheduleCoherence({
      weeklyHours: weekdays,
      maxDaysAhead: 7,
      documentText: "Lunes a viernes de 9:00 a 18:00.",
    });
    expect(result.shortBookingWindow).toBe(true);
  });

  it("confirma cuando los horarios coinciden", () => {
    const result = analyzeScheduleCoherence({
      weeklyHours: weekdays,
      maxDaysAhead: 14,
      documentText: "Lunes a viernes de 9:00 a 18:00.",
    });
    expect(result.status).toBe("matches");
    expect(result.differences).toEqual([]);
  });
});
