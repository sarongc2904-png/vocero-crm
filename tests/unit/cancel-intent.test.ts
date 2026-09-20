import { describe, expect, it } from "vitest";
import { matchesCancellationIntent } from "@/server/agenda/cancel-intent";

describe("intención determinista de cancelar cita", () => {
  it.each([
    "Cancela mi cita",
    "quiero cancelar la reservación",
    "anula mi reserva por favor",
    "cancélala",
  ])("detecta: %s", (text) => {
    expect(matchesCancellationIntent(text)).toBe(true);
  });

  it.each([
    "¿Cuál es la política de cancelación?",
    "cancela el seguimiento",
    "quiero hablar con un asesor",
    "mi cita es mañana",
  ])("no ejecuta por ambigüedad: %s", (text) => {
    expect(matchesCancellationIntent(text)).toBe(false);
  });
});
