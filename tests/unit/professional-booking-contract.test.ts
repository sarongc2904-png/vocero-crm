import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe("contrato de agenda beauty", () => {
  it("usa duración del servicio y zona de la profesional", () => {
    const service = source("src/server/agenda/service.ts");
    expect(service).toContain("schedulingContext?.service.durationMinutes");
    expect(service).toContain("schedulingContext?.professional.timezone");
    expect(service).toContain("findProfessionalSlot");
  });

  it("la base impide traslapes, no solo inicios idénticos", () => {
    const migration = source("drizzle/0021_beauty_services_professionals.sql");
    expect(migration).toContain("EXCLUDE USING gist");
    expect(migration).toContain('tsrange("scheduled_at"');
    expect(migration).toContain("WITH &&");
    expect(migration).toContain('"professional_id" WITH =');
  });
});
