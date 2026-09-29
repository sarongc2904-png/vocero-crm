import { getAuth } from "@/lib/auth";
import { isPasswordResetEmailConfigured } from "@/server/auth/password-reset-email";

export const dynamic = "force-dynamic";

/**
 * AUTH-1 — Comprobación de configuración ANTES de delegar en better-auth.
 *
 * Este segmento estático tiene prioridad sobre `api/auth/[...all]`, así que
 * intercepta solo `POST /api/auth/request-password-reset`.
 *
 * Si el proveedor de correo no está configurado (falta `RESEND_API_KEY` o
 * `AUTH_EMAIL_FROM`), NO se puede enviar ningún enlace. Devolvemos un error
 * operacional explícito en lugar de un 200 con "revisa tu correo", porque ese
 * 200 sería una mentira: el correo nunca llega.
 *
 * Esa comprobación ocurre antes de consultar la base de datos, por lo que la
 * respuesta es byte a byte idéntica para un correo que existe y para uno que
 * no: no se filtra qué cuentas existen.
 */
export async function POST(req: Request) {
  if (!isPasswordResetEmailConfigured()) {
    console.error(
      "[auth] recuperación de contraseña no disponible: falta RESEND_API_KEY o AUTH_EMAIL_FROM"
    );

    return Response.json(
      {
        message:
          "No pudimos procesar la recuperación en este momento. Intenta de nuevo más tarde.",
      },
      { status: 503 }
    );
  }

  return getAuth().handler(req);
}
