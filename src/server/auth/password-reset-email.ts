import { getEnv } from "@/lib/env";

export class PasswordResetEmailError extends Error {
  constructor(
    readonly code: "not_configured" | "provider_failed",
    message: string
  ) {
    super(message);
    this.name = "PasswordResetEmailError";
  }
}

/**
 * AUTH-1 — Estado de configuración del correo de recuperación.
 *
 * Reglas:
 *  - Ambas variables presentes y válidas -> `ok`.
 *  - Ninguna presente -> `not_configured` (estado legítimo: función apagada).
 *  - Solo una presente -> `incomplete` (error de configuración real).
 *
 * Nunca se incluye el VALOR de ninguna variable, solo su nombre.
 */
export type PasswordResetEmailConfig =
  | { status: "ok"; apiKey: string; from: string }
  | { status: "not_configured"; reason: "absent" | "incomplete"; missing: string[] };

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function getPasswordResetEmailConfig(): PasswordResetEmailConfig {
  const env = getEnv();
  const apiKey = env.RESEND_API_KEY?.trim() ?? "";
  const rawFrom = env.AUTH_EMAIL_FROM?.trim() ?? "";
  // `AUTH_EMAIL_FROM` admite el formato "Nombre <correo@dominio>".
  const address = rawFrom.match(/<([^>]+)>/)?.[1]?.trim() ?? rawFrom;

  const missing: string[] = [];
  if (!apiKey) missing.push("RESEND_API_KEY");
  if (!rawFrom) missing.push("AUTH_EMAIL_FROM");

  if (missing.length === 2) {
    return { status: "not_configured", reason: "absent", missing };
  }

  if (missing.length === 1) {
    return { status: "not_configured", reason: "incomplete", missing };
  }

  if (!EMAIL_PATTERN.test(address)) {
    return {
      status: "not_configured",
      reason: "incomplete",
      missing: ["AUTH_EMAIL_FROM (formato inválido)"],
    };
  }

  return { status: "ok", apiKey, from: rawFrom };
}

/**
 * Se comprueba ANTES de tocar better-auth para poder responder un error
 * operacional idéntico para cualquier correo: si la infraestructura no está
 * lista, el usuario no recibe un falso "revisa tu correo" y nadie puede
 * deducir si la cuenta existe (la respuesta es la misma para todas).
 */
export function isPasswordResetEmailConfigured(): boolean {
  return getPasswordResetEmailConfig().status === "ok";
}

export async function sendPasswordResetEmail(input: {
  to: string;
  resetUrl: string;
}) {
  const config = getPasswordResetEmailConfig();

  if (config.status !== "ok") {
    throw new PasswordResetEmailError(
      "not_configured",
      `password_reset_email_not_configured:${config.reason}:${config.missing.join(",")}`
    );
  }

  const { apiKey, from } = config;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: "Conecta Digital — restablece tu contraseña",
      text: [
        "Recibimos una solicitud para restablecer tu contraseña de Conecta Digital.",
        "",
        "Abre este enlace para crear una nueva contraseña:",
        input.resetUrl,
        "",
        "El enlace vence en 1 hora. Si no solicitaste este cambio, ignora este correo.",
      ].join("\n"),
    }),
  });

  if (!response.ok) {
    // Nunca se registra el cuerpo completo (podría traer detalles del token).
    const detail = await response.text().catch(() => "");
    throw new PasswordResetEmailError(
      "provider_failed",
      `password_reset_email_failed:${response.status}:${detail.slice(0, 300)}`
    );
  }
}
