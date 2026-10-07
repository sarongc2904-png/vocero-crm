import { describe, expect, it } from "vitest";
import { matchesCancellationIntent } from "@/server/agenda/cancel-intent";

describe("intención determinista de cancelar cita", () => {
  it.each([
    "Cancela mi cita",
    "quiero cancelar la reservación",
    "anula mi reserva por favor",
    "cancélala",
    // Sin la palabra "cita": el artículo y "del/de las…" la señalan.
    "cancela la del domingo",
    "Cancela la del viernes 9",
    "cancela la de las 10",
    "cancela la de mañana",
    "anula la del lunes",
    "cancela la próxima",
    "cancela el del sábado",
  ])("detecta: %s", (text) => {
    expect(matchesCancellationIntent(text)).toBe(true);
  });

  it.each([
    "¿Cuál es la política de cancelación?",
    "cancela el seguimiento",
    "quiero hablar con un asesor",
    "mi cita es mañana",
    "¿cancelo la del domingo?",
    "si cancelo la del domingo, ¿me cobran?",
    "cancela el pedido",
    "la del domingo está bien",
  ])("no ejecuta por ambigüedad: %s", (text) => {
    expect(matchesCancellationIntent(text)).toBe(false);
  });
});
