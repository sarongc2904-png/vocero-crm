/**
 * Lectura del postMessage "WA_EMBEDDED_SIGNUP" de Meta, como función pura.
 *
 * Cubre los formatos de v3 y v4 de Embedded Signup:
 *   - v4 añade variantes FINISH_* (FINISH_ONLY_WABA, FINISH_OBO_MIGRATION…).
 *     Sin waba_id y phone_number_id no hay nada que conectar: es "partial".
 *   - v4 reporta los errores como CANCEL con error_message / error_code;
 *     v3 los mandaba como ERROR. Ambos son "error".
 *   - CANCEL sin datos de error es un abandono del usuario: "cancel".
 *
 * Nunca devuelve el texto de Meta (error_message): la UI muestra mensajes
 * fijos. error_code y session_id solo se devuelven si tienen forma de
 * identificador corto, para poder registrarlos sin riesgo.
 */

export type EmbeddedSignupMessage =
  | { kind: "finish"; event: string; wabaId: string; phoneNumberId: string }
  | { kind: "partial"; event: string }
  | { kind: "cancel" }
  | { kind: "error"; errorCode: string | null; sessionId: string | null }
  | { kind: "ignore" };

/**
 * Meta: "The exchangeable token code has a time-to-live of 30 seconds".
 * Si llega el code y la selección no llega en este plazo, el intento se
 * reinicia; el margen restante queda para el intercambio en el servidor.
 */
export const EMBEDDED_SIGNUP_SELECTION_TIMEOUT_MS = 15_000;

const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;

export function isTrustedFacebookOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    (url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com"))
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeIdentifier(value: unknown): string | null {
  const text =
    typeof value === "number" && Number.isFinite(value) ? String(value) : nonEmptyString(value);
  return text && SAFE_IDENTIFIER.test(text) ? text : null;
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

export function parseEmbeddedSignupMessage(
  origin: string,
  data: unknown
): EmbeddedSignupMessage {
  if (!isTrustedFacebookOrigin(origin)) return { kind: "ignore" };

  let parsed: unknown = data;
  if (typeof data === "string") {
    try {
      parsed = JSON.parse(data);
    } catch {
      return { kind: "ignore" };
    }
  }
  const payload = record(parsed);
  if (payload?.type !== "WA_EMBEDDED_SIGNUP" || typeof payload.event !== "string") {
    return { kind: "ignore" };
  }
  const details = record(payload.data) ?? {};

  if (payload.event.startsWith("FINISH")) {
    const wabaId = nonEmptyString(details.waba_id);
    const phoneNumberId = nonEmptyString(details.phone_number_id);
    if (wabaId && phoneNumberId) {
      return { kind: "finish", event: payload.event, wabaId, phoneNumberId };
    }
    return { kind: "partial", event: payload.event };
  }

  if (payload.event === "CANCEL") {
    if (!present(details.error_message) && !present(details.error_code)) {
      return { kind: "cancel" };
    }
    return {
      kind: "error",
      errorCode: safeIdentifier(details.error_code),
      sessionId: safeIdentifier(details.session_id),
    };
  }

  if (payload.event === "ERROR") {
    return {
      kind: "error",
      errorCode: safeIdentifier(details.error_code),
      sessionId: safeIdentifier(details.session_id),
    };
  }

  return { kind: "ignore" };
}
