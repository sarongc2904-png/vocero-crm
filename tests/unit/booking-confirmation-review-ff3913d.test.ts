import { describe, expect, it } from "vitest";
import { classifyConfirmation, confirmsAgendaAction } from "@/server/agenda/selection";
import {
  matchesRescheduleIntent,
  resolveBookingReference,
  type ActiveBookingRef,
} from "@/server/agenda/booking-reference";

/**
 * Revisión independiente de ff3913d.
 *
 * E1 — Un emoji que no sea 👍 junto a una confirmación ("sí ❌", "sí 🤔") no
 * confirma: el mensaje es `unclear`, la pendiente se descarta y responde el
 * modelo. Antes la normalización borraba el emoji y "sí ❌" cancelaba.
 *
 * A1 — "okey", "va que va" y "listo" confirman una reserva (no cancelar ni
 * mover). "sí cancela" confirma una cancelación y nada más: un verbo de otra
 * acción ("sí, cancélala" ante "¿agendo?") no confirma. "sí, la 2" ante
 * "¿cuál de tus citas?" elige la 2.
 *
 * A2 — "mejor a las 5", "pásala a las 5", "cámbiala a las 5" hablan de mover
 * una cita que ya existe.
 */

const ACTIONS = ["book", "reschedule", "cancel"] as const;

describe("E1: un emoji distinto de 👍 nunca confirma", () => {
  const WITH_EMOJI = [
    "sí ❌", "sí 🤔", "sí 😡", "sí 👎", "sí 🚫", "sí 🙅", "sí ⛔", "Sí 🙅‍♀️", "sí, ✖️", "sí ✋",
    "sí 😂😂", "si 😊", "sí 🙏", "confirmo 🤔", "claro que sí 😬", "sí cancélala ❌",
    "👎👍", "ok 👎", "👍 ❌", "👍👎", "dale 🤨", "okey 😒", "listo 🙄",
  ];

  it.each(WITH_EMOJI)("'%s' es unclear y no confirma ninguna acción", (text) => {
    expect(classifyConfirmation(text)).toBe("unclear");
    for (const action of ACTIONS) expect(confirmsAgendaAction(text, action), action).toBe(false);
  });

  it.each(["👎", "❌", "🤔"])("'%s' solo no confirma nada", (text) => {
    expect(classifyConfirmation(text)).not.toBe("confirm");
    for (const action of ACTIONS) expect(confirmsAgendaAction(text, action), action).toBe(false);
  });

  it.each(["sí 👍", "Sí 👍🏽", "sí, gracias 👍"])("'%s' confirma las tres acciones", (text) => {
    for (const action of ACTIONS) expect(confirmsAgendaAction(text, action), action).toBe(true);
  });

  it.each(["👍", "👍🏽", "ok 👍", "👍👍"])("'%s' confirma solo agendar", (text) => {
    expect(confirmsAgendaAction(text, "book")).toBe(true);
    expect(confirmsAgendaAction(text, "reschedule")).toBe(false);
    expect(confirmsAgendaAction(text, "cancel")).toBe(false);
  });

  it("signos que no son emoji siguen sin cambiar la lectura", () => {
    for (const text of ["sí!!", "Sí.", "¡sí!", "sí...", "si,gracias", "sí-gracias"]) {
      expect(classifyConfirmation(text), text).toBe("confirm");
    }
  });
});

describe("A1: confirmaciones legítimas que antes se perdían", () => {
  it.each(["okey", "Okey", "va que va", "Va que va!", "listo", "Listo.", "okey, gracias"])(
    "'%s' confirma agendar, no cancelar ni reprogramar",
    (text) => {
      expect(confirmsAgendaAction(text, "book")).toBe(true);
      expect(confirmsAgendaAction(text, "reschedule")).toBe(false);
      expect(confirmsAgendaAction(text, "cancel")).toBe(false);
    }
  );

  it.each(["sí cancela", "Sí, cancela", "sí, cancélala", "si cancelala", "sí, cancelar"])(
    "'%s' confirma cancelar y nada más",
    (text) => {
      expect(confirmsAgendaAction(text, "cancel")).toBe(true);
      expect(confirmsAgendaAction(text, "reschedule")).toBe(false);
      expect(confirmsAgendaAction(text, "book")).toBe(false);
    }
  );

  it.each(["sí, muévela", "sí, cámbiala", "si muevela"])("'%s' confirma reprogramar y nada más", (text) => {
    expect(confirmsAgendaAction(text, "reschedule")).toBe(true);
    expect(confirmsAgendaAction(text, "cancel")).toBe(false);
    expect(confirmsAgendaAction(text, "book")).toBe(false);
  });

  it.each(["sí, agéndala", "sí, resérvala"])("'%s' confirma agendar y nada más", (text) => {
    expect(confirmsAgendaAction(text, "book")).toBe(true);
    expect(confirmsAgendaAction(text, "cancel")).toBe(false);
    expect(confirmsAgendaAction(text, "reschedule")).toBe(false);
  });

  it.each(["okey no", "listo pero mañana", "va que va?", "no cancela", "sí cancela no"])(
    "'%s' sigue sin confirmar nada",
    (text) => {
      for (const action of ACTIONS) expect(confirmsAgendaAction(text, action), action).toBe(false);
    }
  );
});

describe("A1: 'sí, la 2' ante '¿cuál de tus citas?' elige la cita 2", () => {
  const TZ = "America/Mexico_City";
  const a: ActiveBookingRef = { id: "a", startUtc: "2026-10-09T16:00:00.000Z", timezone: TZ, label: "a" };
  const b: ActiveBookingRef = { id: "b", startUtc: "2026-10-12T00:00:00.000Z", timezone: TZ, label: "b" };

  it.each(["sí, la 2", "Sí, la 2.", "si la 2", "ok, la 2", "sí, 2", "claro, la número 2", "sí, la segunda"])(
    "'%s' → la segunda",
    (text) => {
      expect(resolveBookingReference(text, [a, b], { listed: true })?.id).toBe("b");
    }
  );

  it("sin la lista previa, 'sí, la 2' no elige por posición", () => {
    expect(resolveBookingReference("sí, la 2", [a, b])).toBeNull();
  });

  it("'sí, la 3' con dos citas no elige ninguna", () => {
    expect(resolveBookingReference("sí, la 3", [a, b], { listed: true })).toBeNull();
  });
});

describe("A2: 'mejor a las 5' habla de mover la cita que ya tiene", () => {
  it.each([
    "mejor a las 5",
    "Mejor a las 5 de la tarde",
    "mejor a las 17:00",
    "mejor las 5",
    "pásala a las 5",
    "cámbiala a las 5",
    "mejor cámbiala a las 5",
  ])("'%s' es intención de reprogramar", (text) => {
    expect(matchesRescheduleIntent(text)).toBe(true);
  });

  it.each(["quiero a las 5", "a las 5", "las 5 está bien", "mejor no", "mejor otro día", "es mejor el servicio completo"])(
    "'%s' no lo es",
    (text) => {
      expect(matchesRescheduleIntent(text)).toBe(false);
    }
  );
});
