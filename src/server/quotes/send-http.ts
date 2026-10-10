import { QuoteSendError, quoteSendErrorStatus, type QuoteSendView } from "@/server/quotes/whatsapp-send";

/** Lo que el CRM ve de un intento de envío (sin token, sin texto). */
export function sendViewPayload(send: QuoteSendView) {
  return {
    id: send.id,
    status: send.status,
    mode: send.mode,
    errorMessage: send.errorMessage,
    resolution: send.resolution,
    createdAt: send.createdAt.toISOString(),
    completedAt: send.completedAt?.toISOString() ?? null,
  };
}

/** Traduce un `QuoteSendError` al sobre estándar; cualquier otro error se relanza. */
export function quoteSendErrorResponse(err: unknown): Response {
  if (!(err instanceof QuoteSendError)) throw err;
  return Response.json(
    { error: { code: err.code, message: err.message } },
    { status: quoteSendErrorStatus(err.code), headers: { "cache-control": "no-store" } }
  );
}
