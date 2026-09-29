import type { OrganizationPermission } from "@/lib/auth/permissions";
import { BookingError, type BookingResult } from "@/server/agenda/service";

/**
 * 015 — La traducción entre el dominio y HTTP, en un solo sitio.
 *
 * Vive aquí y no dentro de los `route.ts` por dos razones: Next solo admite
 * handlers como exports de una ruta (así que no serían testeables), y porque
 * los códigos y la FORMA del error son contrato observable, no un detalle.
 *
 * Las dos lecciones que costaron caro en producción y que este módulo fija:
 *  - Crear responde **201**, no 200. Un cliente que validaba `=== 200` dejó a
 *    todos los leads sin agendar durante horas, y los mocks no lo vieron
 *    porque respondían 200.
 *  - El error va ANIDADO (`{"error":{"code":…}}`) con `slots` como HERMANO. Un
 *    mock con la forma plana escondió el camino de re-oferta durante semanas:
 *    todo 409 se leía como conflicto genérico y las alternativas nunca se
 *    ofrecían.
 */

export type BookingPayload = {
  bookingId: string;
  meetingLink: string | null;
  linkPending: boolean;
  label: string;
};

export function bookingPayload(result: BookingResult): BookingPayload {
  return {
    bookingId: result.booking.id,
    meetingLink: result.meetingLink,
    /**
     * true ⇒ la cita EXISTE pero el proveedor aún no entregó el enlace.
     * Confirma la cita y di que el enlace llega luego; no prometas uno que no
     * tienes.
     */
    linkPending: result.linkPending,
    label: result.label,
  };
}

export function bookingErrorStatus(code: BookingError["code"]): number {
  switch (code) {
    case "not_found":
      return 404;
    case "invalid":
      return 422;
    case "slot_taken":
    case "slot_not_offered":
      return 409;
  }
}

/** Traduce un `BookingError` al sobre estándar. Cualquier otro error se relanza. */
export function bookingErrorResponse(err: unknown): Response {
  if (!(err instanceof BookingError)) throw err;
  const code = err.code === "invalid" ? "invalid_body" : err.code;
  return Response.json(
    { error: { code, message: err.message }, slots: err.slots },
    { status: bookingErrorStatus(err.code) }
  );
}

/**
 * SEC-V5 — Permiso exigido por cada acción de `PATCH /api/bookings/[id]`.
 *
 * Vive aquí (y no dentro del `route.ts`) para poder probarlo: Next solo admite
 * handlers como exports de una ruta, así que un mapa dentro del archivo sería
 * intestable. No se inventan permisos: se reutilizan los cuatro existentes de
 * `appointments.*`.
 */
export type BookingPatchAction = "reschedule" | "cancel" | "status" | "retry_link";

export const BOOKING_PATCH_PERMISSION: Record<
  BookingPatchAction,
  OrganizationPermission
> = {
  reschedule: "appointments.reschedule",
  cancel: "appointments.cancel",
  // Marcar realizada/no_show cierra el ciclo de una cita existente; no existe
  // `appointments.update`, así que se usa la mutación de cita ya declarada.
  status: "appointments.reschedule",
  // Reintentar el enlace re-entrega el recurso de la cita (camino de creación).
  retry_link: "appointments.create",
};
