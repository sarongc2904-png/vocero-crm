import { sendPasswordResetEmail } from "@/server/auth/password-reset-email";

/**
 * AUTH-1 — Hook `sendResetPassword` de better-auth.
 *
 * Vive en su propio módulo (en vez de inline en `src/lib/auth/index.ts`) para
 * poder probar su contrato real sin cargar la base de datos: es la pieza donde
 * vivía el bug de "falso éxito".
 *
 * Contrato:
 *  - Envía exactamente un correo al usuario.
 *  - Si el envío falla, REGISTRA y RELANZA. Antes se hacía `void ...catch()`,
 *    así que un proveedor caído o sin configurar moría en un console.error y
 *    better-auth respondía 200: el usuario veía "revisa tu correo" para un
 *    correo que nunca se envió. Relanzar hace que el cliente reciba un error
 *    operacional en lugar de una promesa falsa.
 *  - No revela existencia de cuentas por sí mismo: better-auth solo invoca
 *    este hook si el usuario EXISTE, y la respuesta HTTP del endpoint es la
 *    misma en ambos casos (la ruta hace la comprobación de configuración
 *    antes de consultar la base de datos).
 */
export async function sendResetPasswordForUser(input: {
  user: { email: string };
  url: string;
}): Promise<void> {
  try {
    await sendPasswordResetEmail({
      to: input.user.email,
      resetUrl: input.url,
    });
  } catch (error) {
    console.error(
      "[auth] fallo operacional enviando recuperación de contraseña",
      error
    );
    throw error;
  }
}
