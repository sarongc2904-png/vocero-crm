import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * AUTH-1 — Recuperación de contraseña: nunca reportar un éxito falso.
 *
 * Bug corregido: `sendResetPassword` hacía `void sendPasswordResetEmail(...)
 * .catch(console.error)`, así que con Resend sin configurar el endpoint
 * respondía 200 y el usuario veía "recibirás un enlace" para un correo que
 * nunca se envió.
 */

const ENV_KEYS = ["RESEND_API_KEY", "AUTH_EMAIL_FROM"] as const;

/**
 * `getEnv()` exige estas variables para parsear; las pruebas no dependen de
 * ningún `.env` local, así que se fijan aquí (valores de mentira, sin secretos).
 */
const BASE_ENV = {
  APP_BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  BETTER_AUTH_SECRET: "secreto-de-prueba-suficientemente-largo",
  ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  META_WEBHOOK_VERIFY_TOKEN: "verify-token-de-prueba",
} as const;

Object.assign(process.env, BASE_ENV);

const ORIGINAL_ENV = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Carga los módulos con el entorno indicado y una caché de env limpia. */
async function load(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, vars);

  const email = await import("@/server/auth/password-reset-email");
  const hook = await import("@/server/auth/send-reset-password");
  return { email, hook };
}

function jsonResponse(status: number, body: unknown = { id: "ok" }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe("AUTH-1 · configuración del correo de recuperación", () => {
  it("caso 1 — sin RESEND_API_KEY no se reporta éxito y no se llama a ningún proveedor", async () => {
    const { email, hook } = await load({});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(email.isPasswordResetEmailConfigured()).toBe(false);
    expect(email.getPasswordResetEmailConfig()).toMatchObject({
      status: "not_configured",
      reason: "absent",
    });

    const error = await hook
      .sendResetPasswordForUser({
        user: { email: "alguien@example.com" },
        url: "https://crm.example.com/reset-password?token=t",
      })
      .then(
        () => null,
        (e: unknown) => e as Error
      );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("password_reset_email_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caso 2 — sin AUTH_EMAIL_FROM no se reporta éxito (configuración incompleta)", async () => {
    const { email, hook } = await load({ RESEND_API_KEY: "re_clave_de_prueba" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(email.isPasswordResetEmailConfigured()).toBe(false);
    const config = email.getPasswordResetEmailConfig();
    expect(config).toMatchObject({ status: "not_configured", reason: "incomplete" });
    // El diagnóstico nombra la variable que falta, jamás su valor.
    expect(JSON.stringify(config)).not.toContain("re_clave_de_prueba");

    const error = await hook
      .sendResetPasswordForUser({
        user: { email: "alguien@example.com" },
        url: "https://crm.example.com/reset-password?token=t",
      })
      .then(
        () => null,
        (e: unknown) => e as Error
      );

    expect(error?.message).toContain("AUTH_EMAIL_FROM");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rechaza un remitente con formato inválido en vez de intentar el envío", async () => {
    const { email } = await load({
      RESEND_API_KEY: "re_clave_de_prueba",
      AUTH_EMAIL_FROM: "no-es-un-correo",
    });

    expect(email.isPasswordResetEmailConfigured()).toBe(false);
  });

  it("acepta el formato «Nombre <correo@dominio>»", async () => {
    const { email } = await load({
      RESEND_API_KEY: "re_clave_de_prueba",
      AUTH_EMAIL_FROM: "CRM <acceso@kompralo.com.mx>",
    });

    expect(email.isPasswordResetEmailConfigured()).toBe(true);
  });
});

describe("AUTH-1 · envío con proveedor configurado", () => {
  it("caso 4 — cuenta existente con proveedor OK: envía exactamente una vez con el enlace", async () => {
    const { hook } = await load({
      RESEND_API_KEY: "re_clave_de_prueba",
      AUTH_EMAIL_FROM: "CRM <acceso@kompralo.com.mx>",
    });
    const fetchMock = vi.fn(async () => jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const resetUrl = "https://crm.kompralo.com.mx/reset-password?token=abc123";
    await expect(
      hook.sendResetPasswordForUser({
        user: { email: "cliente@example.com" },
        url: resetUrl,
      })
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.to).toEqual(["cliente@example.com"]);
    expect(body.from).toBe("CRM <acceso@kompralo.com.mx>");
    expect(body.text).toContain(resetUrl);
  });

  it("caso 5 — proveedor que falla: error operacional, no un éxito silencioso", async () => {
    const { hook } = await load({
      RESEND_API_KEY: "re_clave_de_prueba",
      AUTH_EMAIL_FROM: "CRM <acceso@kompralo.com.mx>",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(500, { message: "internal" }))
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const error = await hook
      .sendResetPasswordForUser({
        user: { email: "cliente@example.com" },
        url: "https://crm.kompralo.com.mx/reset-password?token=abc123",
      })
      .then(
        () => null,
        (e: unknown) => e as Error
      );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("password_reset_email_failed:500");
    // El fallo queda registrado como error operacional (no se traga).
    expect(errorSpy).toHaveBeenCalled();
  });

  it("nunca imprime la API key ni el token del enlace en el error", async () => {
    const { hook } = await load({
      RESEND_API_KEY: "re_clave_super_secreta",
      AUTH_EMAIL_FROM: "CRM <acceso@kompralo.com.mx>",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(422, { message: "domain not verified" }))
    );
    const logged: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(...args);
    });

    const error = await hook
      .sendResetPasswordForUser({
        user: { email: "cliente@example.com" },
        url: "https://crm.kompralo.com.mx/reset-password?token=token_secreto_xyz",
      })
      .then(
        () => null,
        (e: unknown) => e as Error
      );

    const dump = `${error?.message}\n${logged.map(String).join("\n")}`;
    expect(dump).not.toContain("re_clave_super_secreta");
    expect(dump).not.toContain("token_secreto_xyz");
  });
});

describe("AUTH-1 · ruta de solicitud (anti-enumeración)", () => {
  async function loadRoute(configured: boolean) {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
    if (configured) {
      process.env.RESEND_API_KEY = "re_clave_de_prueba";
      process.env.AUTH_EMAIL_FROM = "CRM <acceso@kompralo.com.mx>";
    }

    const handler = vi.fn(async () => Response.json({ status: true }));
    vi.doMock("@/lib/auth", () => ({ getAuth: () => ({ handler }) }));
    const route = await import("@/app/api/auth/request-password-reset/route");
    return { route, handler };
  }

  function request(email: string) {
    return new Request("https://crm.kompralo.com.mx/api/auth/request-password-reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
  }

  it("casos 1 y 3 — sin proveedor: error operacional idéntico para cuenta existente e inexistente", async () => {
    const { route, handler } = await loadRoute(false);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const existente = await route.POST(request("cliente@example.com"));
    const inexistente = await route.POST(request("nadie@example.com"));

    expect(existente.status).toBe(503);
    expect(inexistente.status).toBe(503);

    const cuerpoExistente = await existente.text();
    const cuerpoInexistente = await inexistente.text();
    // Misma respuesta byte a byte: no se puede deducir si la cuenta existe.
    expect(cuerpoExistente).toBe(cuerpoInexistente);
    expect(cuerpoExistente).toContain("No pudimos procesar la recuperación");
    // Y jamás se reporta éxito.
    expect(cuerpoExistente).not.toContain("recibirás un enlace");
    // Ni siquiera se consulta la base de datos / better-auth.
    expect(handler).not.toHaveBeenCalled();
  });

  it("caso 3 — con proveedor configurado: delega en better-auth (respuesta neutra intacta)", async () => {
    const { route, handler } = await loadRoute(true);

    const response = await route.POST(request("cliente@example.com"));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: true });
  });
});
