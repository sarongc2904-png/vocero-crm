/**
 * Respaldo determinista para cancelación de citas.
 *
 * Igual que el detector de handoff, corre antes del LLM para que una frase
 * inequívoca no dependa del modelo. Exige una acción de cancelación y una
 * referencia a la cita, salvo pronombres imperativos explícitos como
 * "cancélala" que solo tienen sentido dentro del contexto conversacional.
 */
const CANCEL_APPOINTMENT_REGEX =
  /\b(?:cancel(?:a|ar|en|emos)|anul(?:a|ar|en|emos))\b[\s\S]{0,40}\b(?:mi\s+)?(?:cita|reservaci[oó]n|reserva|turno)\b|\b(?:canc[eé]lala|an[uú]lala)\b/i;

export function matchesCancellationIntent(text: string): boolean {
  return CANCEL_APPOINTMENT_REGEX.test(text);
}
