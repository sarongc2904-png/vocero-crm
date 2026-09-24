import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("recuperación de contraseña", () => {
  it("agrega visor y enlace de recuperación al login", () => {
    const login = source("src/app/(auth)/login/page.tsx");

    expect(login).toContain("showPassword");
    expect(login).toContain('href="/forgot-password"');
    expect(login).toContain("¿Olvidaste tu contraseña?");
    expect(login).toContain("Mostrar contraseña");
  });

  it("solicita recuperación sin revelar si el correo existe", () => {
    const forgot = source("src/app/(auth)/forgot-password/page.tsx");

    expect(forgot).toContain("authClient.requestPasswordReset");
    expect(forgot).toContain("/reset-password");
    expect(forgot).toContain("Si existe una cuenta con ese correo");
  });

  it("restablece contraseña con token y confirma contraseña", () => {
    const reset = source("src/app/(auth)/reset-password/page.tsx");

    expect(reset).toContain("authClient.resetPassword");
    expect(reset).toContain('searchParams.get("token")');
    expect(reset).toContain("Las contraseñas no coinciden");
    expect(reset).toContain("Mostrar confirmación");
  });

  it("configura expiración, revocación de sesiones y correo transaccional", () => {
    const auth = source("src/lib/auth/index.ts");
    const email = source("src/server/auth/password-reset-email.ts");
    const env = source("src/lib/env.ts");

    expect(auth).toContain("resetPasswordTokenExpiresIn: 3600");
    expect(auth).toContain("revokeSessionsOnPasswordReset: true");
    expect(auth).toContain("sendResetPassword");
    expect(auth).toContain('"/request-password-reset"');
    expect(email).toContain("https://api.resend.com/emails");
    expect(env).toContain("RESEND_API_KEY");
    expect(env).toContain("AUTH_EMAIL_FROM");
  });

  it("agrega visor a la contraseña temporal del alta de cliente", () => {
    const client = source("src/components/admin/commercial-admin-client.tsx");

    expect(client).toContain("showPassword");
    expect(client).toContain('type={showPassword ? "text" : "password"}');
    expect(client).toContain("Generar");
  });
});
