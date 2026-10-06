import { describe, expect, it } from "vitest";
import * as selection from "@/server/agenda/selection";

/**
 * Detección de una confirmación EXPLÍCITA para ejecutar una acción de agenda
 * pendiente (reservar, mover o cancelar).
 *
 * Ante la duda NO confirma: una negación, una pregunta, un "pero"/"mejor" o
 * una hora/día distintos impiden confirmar. `classifyConfirmation` distingue
 * además la duda ("unclear": empieza afirmando pero trae algo más, se repite
 * la pregunta una vez) del resto ("other": negativa, cambio de hora o de tema;
 * la pendiente se invalida y el mensaje sigue su flujo).
 */

const POSITIVE = [
  "sí",
  "si",
  "Sí.",
  "sí!!",
  "ok",
  "okay",
  "va",
  "dale",
  "claro",
  "claro que sí",
  "perfecto",
  "de acuerdo",
  "está bien",
  "sí, gracias",
  "sí, por favor",
  "confirmo",
  "sí, cancélala",
  "sí, agéndala",
  "sí quiero",
  "vale",
  "sip",
  "sii",
  "👍",
  "👍🏽",
];

const NEGATIVE = [
  "claro que no",
  "ok no",
  "por favor no",
  "sí pero a las 5",
  "vale, pero mejor el jueves",
  "sí, ¿y cuánto cuesta?",
  "va a llover?",
  "no, sí a las 5",
  "no",
  "no gracias",
  "mejor no",
  "si me pudieras decir…",
  "si me surge algo te aviso",
  "sí, pero primero dime cuánto cuesta cancelar mi cita",
  "ni loco",
  "nunca",
  "sí a las 5",
  "ok, a las 12",
  "sí, el jueves",
  "sí, mañana",
  "sí, el 7 de octubre",
  "sí 16:30",
  "gracias",
  "hola",
  "👎",
  "👍 pero más tarde",
  "",
];

describe("isAffirmativeConfirmation", () => {
  it.each(POSITIVE)("'%s' confirma", (text) => {
    expect(selection.isAffirmativeConfirmation(text)).toBe(true);
  });

  it.each(NEGATIVE)("'%s' NO confirma", (text) => {
    expect(selection.isAffirmativeConfirmation(text)).toBe(false);
  });
});

describe("classifyConfirmation", () => {
  it.each(POSITIVE)("'%s' → confirm", (text) => {
    expect(selection.classifyConfirmation(text)).toBe("confirm");
  });

  it.each([
    "sí, ¿y cuánto cuesta?",
    "va a llover?",
    "ok, pero rápido",
    "dale, mejor",
    "¿sí?",
    "ok?",
    "¿de acuerdo?",
    "ok, mándame la ubicación",
    "vale, cuéntame más",
    "sí, una pregunta",
  ])("'%s' → unclear (empieza afirmando, trae duda)", (text) => {
    expect(selection.classifyConfirmation(text)).toBe("unclear");
  });

  it.each([
    "claro que no",
    "ok no",
    "por favor no",
    "no gracias",
    "sí pero a las 5",
    "vale, pero mejor el jueves",
    "sí, mañana",
    "¿tienen estacionamiento?",
    "si me pudieras decir…",
    "hola",
  ])("'%s' → other (negativa, otra hora/día o tema distinto)", (text) => {
    expect(selection.classifyConfirmation(text)).toBe("other");
  });

  it("barrido: toda frase de la tabla cae en una sola rama y ninguna rama queda vacía", () => {
    const branches = { confirm: 0, unclear: 0, other: 0 };
    for (const text of [...POSITIVE, ...NEGATIVE]) {
      const verdict = selection.classifyConfirmation(text);
      branches[verdict] += 1;
      expect(verdict === "confirm", text).toBe(POSITIVE.includes(text));
    }
    expect(branches.confirm).toBe(POSITIVE.length);
    expect(branches.unclear).toBeGreaterThan(0);
    expect(branches.other).toBeGreaterThan(0);
  });
});
