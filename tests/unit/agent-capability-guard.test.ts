import { describe, expect, it } from "vitest";
import {
  AGENDA_DISABLED_SAFE_REPLY,
  enforceAgentCapabilities,
  promisesAgenda,
} from "@/server/ai/capability-guard";

describe("agent capability guard", () => {
  it("bloquea una promesa de agenda cuando la agenda está deshabilitada", () => {
    const text =
      "Necesito confirmar el precio. ¿Te gustaría que te ayude a agendar una cita?";

    expect(promisesAgenda(text)).toBe(true);
    expect(enforceAgentCapabilities({ text, agenda: false })).toBe(
      AGENDA_DISABLED_SAFE_REPLY
    );
  });

  it("bloquea ofertas de horarios disponibles sin capacidad de agenda", () => {
    const text = "Puedo mostrarte horarios disponibles para mañana.";

    expect(enforceAgentCapabilities({ text, agenda: false })).toBe(
      AGENDA_DISABLED_SAFE_REPLY
    );
  });

  it("no altera una respuesta informativa cuando la agenda está deshabilitada", () => {
    const text =
      "No tengo ese precio confirmado en la información disponible.";

    expect(enforceAgentCapabilities({ text, agenda: false })).toBe(text);
  });

  it("no altera una promesa de agenda cuando la capacidad sí está habilitada", () => {
    const text = "Puedo ayudarte a agendar una cita.";

    expect(enforceAgentCapabilities({ text, agenda: true })).toBe(text);
  });
});
