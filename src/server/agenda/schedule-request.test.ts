import { describe, expect, it } from "vitest";
import { hasSchedulingSignal } from "@/server/agenda/schedule-request";

const now = new Date("2026-09-17T15:00:00.000Z");
const timezone = "America/Mexico_City";

function signal(text: string): boolean {
  return hasSchedulingSignal({ text, now, timezone });
}

describe("hasSchedulingSignal", () => {
  it("keeps informational service questions out of agenda", () => {
    expect(signal("¿Qué servicios ofrecen?")).toBe(false);
    expect(signal("cuéntame sobre sus servicios")).toBe(false);
    expect(signal("que servicios manejan")).toBe(false);
  });

  it("allows explicit appointment intent even when a service is mentioned", () => {
    expect(signal("quiero agendar ese servicio")).toBe(true);
    expect(signal("quiero reservar una cita")).toBe(true);
    expect(signal("tienen disponibilidad")).toBe(true);
  });

  it("allows temporal scope and voice-style transcripts", () => {
    expect(signal("que disponibilidad tienen mañana")).toBe(true);
    expect(signal("quiero reservar una cita para mañana")).toBe(true);
  });
});
