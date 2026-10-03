import { describe, expect, it } from "vitest";
import { MEXICO_TIMEZONES } from "@/lib/time/mexico-timezones";

function offset(timeZone: string, iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
    hour: "2-digit",
  })
    .formatToParts(new Date(iso))
    .find((part) => part.type === "timeZoneName")?.value;
}

describe("zonas horarias mexicanas", () => {
  it("incluye Matamoros como frontera separada de Centro de México", () => {
    const matamoros = MEXICO_TIMEZONES.find(
      (option) => option.value === "America/Matamoros"
    );
    const mexico = MEXICO_TIMEZONES.find(
      (option) => option.value === "America/Mexico_City"
    );
    expect(matamoros?.label).toContain("Tamaulipas frontera");
    expect(mexico?.label).toBe("Centro de México");
  });

  it("Matamoros coincide en enero y difiere en julio por horario fronterizo", () => {
    const january = "2026-01-15T12:00:00Z";
    const july = "2026-07-15T12:00:00Z";
    expect(offset("America/Matamoros", january)).toBe(
      offset("America/Mexico_City", january)
    );
    expect(offset("America/Matamoros", july)).not.toBe(
      offset("America/Mexico_City", july)
    );
  });
});
