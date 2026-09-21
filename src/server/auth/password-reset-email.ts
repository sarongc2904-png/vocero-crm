import { getEnv } from "@/lib/env";

export async function sendPasswordResetEmail(input: {
  to: string;
  resetUrl: string;
}) {
  const env = getEnv();
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.AUTH_EMAIL_FROM?.trim();

  if (!apiKey || !from) {
    throw new Error("password_reset_email_not_configured");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: "Restablece tu contraseña",
      text: [
        "Recibimos una solicitud para restablecer tu contraseña.",
        "",
        "Abre este enlace para crear una nueva contraseña:",
        input.resetUrl,
        "",
        "El enlace vence en 1 hora. Si no solicitaste este cambio, ignora este correo.",
      ].join("\n"),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `password_reset_email_failed:${response.status}:${detail.slice(0, 300)}`
    );
  }
}
