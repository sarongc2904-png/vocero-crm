import { describe, expect, it } from "vitest";
import { BeautyCatalogError } from "@/server/beauty/catalog";
import { validateWeeklyIntervals } from "@/server/beauty/availability";

describe("disponibilidad por profesional", () => {
  it("acepta varios intervalos ordenables en un día", () => {
    expect(() =>
      validateWeeklyIntervals(
        [
          { dayOfWeek: 1, startMinute: 840, endMinute: 1080 },
          { dayOfWeek: 1, startMinute: 540, endMinute: 780 },
        ],
        "Horario"
      )
    ).not.toThrow();
  });

  it("rechaza traslapes y rangos no programables", () => {
    expect(() =>
      validateWeeklyIntervals(
        [
          { dayOfWeek: 2, startMinute: 540, endMinute: 780 },
          { dayOfWeek: 2, startMinute: 720, endMinute: 900 },
        ],
        "Horario"
      )
    ).toThrow(BeautyCatalogError);
    expect(() =>
      validateWeeklyIntervals(
        [{ dayOfWeek: 7, startMinute: 600, endMinute: 500 }],
        "Horario"
      )
    ).toThrow(BeautyCatalogError);
  });
});
