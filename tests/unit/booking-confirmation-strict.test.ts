import { describe, expect, it } from "vitest";
import { classifyConfirmation, confirmsAgendaAction } from "@/server/agenda/selection";
import {
  matchesRescheduleIntent,
  resolveBookingReference,
  type ActiveBookingRef,
} from "@/server/agenda/booking-reference";

/**
 * Cancelar y reprogramar son destructivos: solo un "sí" claro los confirma.
 * Agendar conserva la lectura amplia ("ok", "dale", "👍"): una reserva no
 * destruye nada y el cliente acaba de elegir la hora.
 */
describe("confirmsAgendaAction", () => {
  const CLEAR = [
    "sí", "Si", "SÍ", "Sí.", "sí!!", "sip", "siii", "sí, cancélala", "si, cancelala", "sí, muévela",
    "confirmo", "confirmado", "sí, gracias", "si gracias", "claro que sí", "claro que si", "sí, por favor",
    "correcto", "así es", "de acuerdo", "sí 👍", "Sí, adelante",
  ];
  const ACKNOWLEDGEMENTS = [
    "ok", "OK", "Ok.", "okay", "ok gracias", "ok, gracias", "gracias", "muchas gracias", "👍", "👍🏽",
    "dale", "va", "vale", "perfecto", "está bien", "listo", "genial", "por favor",
  ];
  const NEVER = [
    "no", "claro que no", "ok no", "por favor no", "sí pero a las 5", "sí, ¿y cuánto cuesta?",
    "va a llover?", "si me surge algo", "sí y no", "no sé", "👎",
  ];

  it.each(CLEAR)("'%s' confirma cancelar, reprogramar y agendar", (text) => {
    expect(confirmsAgendaAction(text, "cancel")).toBe(true);
    expect(confirmsAgendaAction(text, "reschedule")).toBe(true);
    expect(confirmsAgendaAction(text, "book")).toBe(true);
  });

  it.each(ACKNOWLEDGEMENTS)("'%s' NO confirma cancelar ni reprogramar", (text) => {
    expect(confirmsAgendaAction(text, "cancel")).toBe(false);
    expect(confirmsAgendaAction(text, "reschedule")).toBe(false);
  });

  it.each(["ok", "ok gracias", "dale", "va", "perfecto", "está bien", "👍", "👍🏽"])(
    "'%s' sigue confirmando una reserva (comportamiento sin cambios)",
    (text) => {
      expect(confirmsAgendaAction(text, "book")).toBe(true);
    }
  );

  it.each(NEVER)("'%s' no confirma nada", (text) => {
    for (const action of ["book", "reschedule", "cancel"] as const) {
      expect(confirmsAgendaAction(text, action)).toBe(false);
    }
  });

  it("los barridos no están vacíos", () => {
    expect(CLEAR.length + ACKNOWLEDGEMENTS.length + NEVER.length).toBeGreaterThan(40);
  });
});

describe("tope de palabras de una confirmación", () => {
  it("6 palabras de confirmación confirman; 7 ya no (se lee como mensaje, no como 'sí')", () => {
    expect(classifyConfirmation("sí gracias perfecto listo genial excelente")).toBe("confirm");
    expect(classifyConfirmation("sí gracias perfecto listo genial excelente porfa")).toBe("unclear");
    expect(confirmsAgendaAction("sí sí sí sí sí sí sí", "cancel")).toBe(false);
  });
});

const TZ = "America/Mexico_City";
const ref = (id: string, iso: string): ActiveBookingRef => ({
  id,
  startUtc: iso,
  timezone: TZ,
  label: id,
});
// Viernes 9 de octubre de 2026, 10:00 y lunes 12 de octubre de 2026, 18:00 (México).
const FRI = ref("bk_fri", "2026-10-09T16:00:00.000Z");
const MON = ref("bk_mon", "2026-10-13T00:00:00.000Z");
const BOTH = [FRI, MON];

describe("resolveBookingReference", () => {
  it.each([
    ["cancela mi cita del viernes", "bk_fri"],
    ["cancela la del lunes", "bk_mon"],
    ["la del 12", "bk_mon"],
    ["la del 9 de octubre", "bk_fri"],
    ["la de las 6 de la tarde", "bk_mon"],
    ["la de las 18:00", "bk_mon"],
    ["la de las 10", "bk_fri"],
  ])("'%s' → %s", (text, id) => {
    expect(resolveBookingReference(text, BOTH)?.id).toBe(id);
  });

  it.each(["cancela mi cita", "la de la semana", "el martes", "la de las 3"])(
    "'%s' no identifica una sola cita",
    (text) => {
      expect(resolveBookingReference(text, BOTH)).toBeNull();
    }
  );

  it("ordinales solo cuenta si el agente acaba de listar las citas", () => {
    expect(resolveBookingReference("la segunda", BOTH)).toBeNull();
    expect(resolveBookingReference("la segunda", BOTH, { listed: true })?.id).toBe("bk_mon");
    expect(resolveBookingReference("1", BOTH, { listed: true })?.id).toBe("bk_fri");
    expect(resolveBookingReference("la opción 2", BOTH, { listed: true })?.id).toBe("bk_mon");
    expect(resolveBookingReference("la 3", BOTH, { listed: true })).toBeNull();
  });
});

describe("matchesRescheduleIntent", () => {
  it.each([
    "quiero cambiar mi cita",
    "¿puedo mover mi cita?",
    "muévela al jueves",
    "reprogramar",
    "necesito reagendar",
    "cámbiala a las 5",
  ])("'%s' es reprogramar", (text) => {
    expect(matchesRescheduleIntent(text)).toBe(true);
  });

  it.each(["quiero una cita", "a las 11", "¿tienen cambio de 500?", "me muevo en bici"])(
    "'%s' no es reprogramar",
    (text) => {
      expect(matchesRescheduleIntent(text)).toBe(false);
    }
  );
});

/**
 * "claro" a secas es un acuse de recibo: confirma una reserva, pero no basta
 * para cancelar ni mover una cita. "claro que sí" lleva un "sí" explícito y
 * sigue confirmando todo.
 */
describe("'claro' en cancelar y reprogramar", () => {
  it.each(["claro que sí", "claro que si", "Claro que sí."])("'%s' confirma cancelar, reprogramar y agendar", (text) => {
    for (const action of ["cancel", "reschedule", "book"] as const) {
      expect(confirmsAgendaAction(text, action), `${action} '${text}'`).toBe(true);
    }
  });

  it.each(["claro", "Claro.", "claro, gracias", "claro, entiendo"])("'%s' NO confirma cancelar ni reprogramar", (text) => {
    expect(confirmsAgendaAction(text, "cancel")).toBe(false);
    expect(confirmsAgendaAction(text, "reschedule")).toBe(false);
  });

  it.each(["claro", "claro, gracias"])("'%s' sigue confirmando una reserva", (text) => {
    expect(confirmsAgendaAction(text, "book")).toBe(true);
  });

  it.each(["claro que no", "claro, que no", "claro que no la canceles"])("'%s' no confirma nada", (text) => {
    for (const action of ["book", "reschedule", "cancel"] as const) {
      expect(confirmsAgendaAction(text, action), `${action} '${text}'`).toBe(false);
    }
  });
});
