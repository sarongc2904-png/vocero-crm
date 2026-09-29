import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { betterAuth } from "better-auth";
import { memoryAdapter, type MemoryDB } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";

/**
 * Casos 6 y 7 del flujo de recuperación de contraseña, corridos contra la
 * librería real (`better-auth@1.6.23`) y sin Postgres: el adaptador en memoria
 * que la propia librería publica en `better-auth/adapters/memory`.
 *
 * Lo que se prueba es la conducta completa —un enlace válido cambia la
 * contraseña, un token inválido o caducado no la toca y las sesiones previas
 * caen— no el código fuente que la configura. Las opciones de
 * `emailAndPassword` son el calco de `src/lib/auth/index.ts`; el último caso
 * lee ese archivo para que el calco no se desincronice en silencio.
 */

const BASE_URL = "http://localhost:3000";
const REDIRECT_TO = `${BASE_URL}/reset-password`;

/** Cuenta de prueba: jamás un correo ni una contraseña reales. */
const CORREO = "alguien@example.com";
const PASSWORD_VIEJA = "contrasena-vieja-123";
const PASSWORD_NUEVA = "contrasena-nueva-456";

/** Segundos que producción concede a un enlace (`resetPasswordTokenExpiresIn`). */
const EXPIRACION_SEGUNDOS = 3600;

/** Holgura al comparar la caducidad guardada con el reloj de la prueba. */
const HOLGURA_SEGUNDOS = 60;

type Enlace = { email: string; url: string; token: string };

/** La fila de `verification` que respalda un token. */
type FilaDeVerificacion = {
  identifier: string;
  value: string;
  expiresAt: Date;
};

/**
 * Instancia aislada por caso, con el mismo contrato que producción.
 * `sendResetPassword` captura la URL que genera better-auth —la misma que en
 * producción viaja a Resend— en lugar de enviar correo alguno.
 */
function crearEscenario() {
  const db: MemoryDB = { user: [], session: [], account: [], verification: [] };
  const enlaces: Enlace[] = [];

  const auth = betterAuth({
    baseURL: BASE_URL,
    secret: "secreto-de-prueba-suficientemente-largo",
    database: memoryAdapter(db),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      minPasswordLength: 8,
      resetPasswordTokenExpiresIn: EXPIRACION_SEGUNDOS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url, token }) => {
        enlaces.push({ email: user.email, url, token });
      },
    },
  });

  return { auth, db, enlaces };
}

type Escenario = ReturnType<typeof crearEscenario>;

async function crearCuenta(escenario: Escenario): Promise<void> {
  await escenario.auth.api.signUpEmail({
    body: { email: CORREO, password: PASSWORD_VIEJA, name: "Alguien de prueba" },
  });
}

/** El enlace que better-auth habría mandado por correo. */
async function pedirEnlace(escenario: Escenario): Promise<Enlace> {
  await escenario.auth.api.requestPasswordReset({
    body: { email: CORREO, redirectTo: REDIRECT_TO },
  });
  const enlace = escenario.enlaces.at(-1);
  if (!enlace) throw new Error("better-auth no invocó sendResetPassword");
  return enlace;
}

/** El token viaja en el path: `/reset-password/<token>?callbackURL=…`. */
function tokenDeLaUrl(url: string): string {
  const partes = new URL(url).pathname.split("/").filter(Boolean);
  const token = partes.at(-1);
  if (!token || token === "reset-password") {
    throw new Error("la URL de recuperación no trae token en el path");
  }
  return token;
}

/** Código de error de better-auth, sin depender de la forma completa del error. */
function codigoDeError(error: Error): string {
  const body = (error as { body?: { code?: string } }).body;
  return body?.code ?? "";
}

/** Volcado del error para comprobar que no filtra nada de la petición. */
function volcadoDelError(error: Error): string {
  const { body, message, status } = error as {
    body?: unknown;
    message: string;
    status?: unknown;
  };
  return [message, String(status ?? ""), JSON.stringify(body ?? {})].join("\n");
}

async function capturarError(promesa: Promise<unknown>): Promise<Error> {
  try {
    await promesa;
  } catch (error) {
    return error as Error;
  }
  throw new Error("se esperaba un rechazo y la operación se resolvió");
}

/**
 * `true` solo si better-auth acepta esa contraseña. Un rechazo por cualquier
 * otra causa se reporta como tal en vez de contarse como "contraseña
 * incorrecta", que es justo lo que estas pruebas quieren distinguir.
 */
async function puedeEntrar(
  escenario: Escenario,
  password: string
): Promise<boolean> {
  try {
    await escenario.auth.api.signInEmail({ body: { email: CORREO, password } });
    return true;
  } catch (error) {
    expect(codigoDeError(error as Error)).toBe("INVALID_EMAIL_OR_PASSWORD");
    return false;
  }
}

/**
 * La fila de `verification` que respalda el token. Se relee desde `db` en cada
 * llamada porque el adaptador reemplaza el array al confirmar transacciones.
 */
function filaDeVerificacion(
  escenario: Escenario,
  token: string
): FilaDeVerificacion | undefined {
  const filas = (escenario.db.verification ?? []) as FilaDeVerificacion[];
  return filas.find((fila) => fila.identifier === `reset-password:${token}`);
}

function exigirFilaDeVerificacion(
  escenario: Escenario,
  token: string
): FilaDeVerificacion {
  const fila = filaDeVerificacion(escenario, token);
  if (!fila) throw new Error("no hay fila de verificación para el token emitido");
  return fila;
}

/** El id de la cuenta creada, leído del adaptador en memoria. */
function idDelUsuario(escenario: Escenario): string {
  const usuarios = (escenario.db.user ?? []) as { id: string }[];
  const usuario = usuarios[0];
  if (!usuario) throw new Error("no hay usuario en el adaptador en memoria");
  return usuario.id;
}

/**
 * Inicia sesión por el endpoint HTTP real y devuelve las cabeceras de la
 * cookie de sesión, tal como las reenviaría un navegador.
 */
async function iniciarSesionPorHttp(escenario: Escenario): Promise<Headers> {
  const respuesta = await escenario.auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: CORREO, password: PASSWORD_VIEJA }),
    })
  );
  expect(respuesta.status).toBe(200);

  const pares = respuesta.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .filter((par): par is string => Boolean(par));
  expect(pares.join("; ")).toContain("better-auth.session_token");
  return new Headers({ cookie: pares.join("; ") });
}

describe("recuperación de contraseña · flujo real de better-auth", () => {
  it("caso 6 — un enlace válido cambia la contraseña: entra la nueva y ya no la vieja", async () => {
    const escenario = crearEscenario();
    await crearCuenta(escenario);
    expect(await puedeEntrar(escenario, PASSWORD_VIEJA)).toBe(true);

    const enlace = await pedirEnlace(escenario);
    expect(enlace.email).toBe(CORREO);
    // La URL sale del hook de producción: token en el path y el destino pedido.
    expect(enlace.url).toContain("/reset-password/");
    expect(enlace.url).toContain(encodeURIComponent(REDIRECT_TO));

    const token = tokenDeLaUrl(enlace.url);
    expect(enlace.token).toBe(token);

    await expect(
      escenario.auth.api.resetPassword({
        body: { newPassword: PASSWORD_NUEVA, token },
      })
    ).resolves.toMatchObject({ status: true });

    expect(await puedeEntrar(escenario, PASSWORD_NUEVA)).toBe(true);
    expect(await puedeEntrar(escenario, PASSWORD_VIEJA)).toBe(false);
  });

  it("caso 6 — el enlace es de un solo uso: repetirlo no vuelve a cambiar la contraseña", async () => {
    const escenario = crearEscenario();
    await crearCuenta(escenario);
    const { url } = await pedirEnlace(escenario);
    const token = tokenDeLaUrl(url);

    await escenario.auth.api.resetPassword({
      body: { newPassword: PASSWORD_NUEVA, token },
    });
    expect(filaDeVerificacion(escenario, token)).toBeUndefined();

    const tercera = "tercera-contrasena-789";
    const error = await capturarError(
      escenario.auth.api.resetPassword({
        body: { newPassword: tercera, token },
      })
    );

    expect(codigoDeError(error)).toBe("INVALID_TOKEN");
    expect(await puedeEntrar(escenario, PASSWORD_NUEVA)).toBe(true);
    expect(await puedeEntrar(escenario, tercera)).toBe(false);
  });

  it("caso 6 — el enlace caduca a los 3600 s que fija producción", async () => {
    const escenario = crearEscenario();
    await crearCuenta(escenario);
    const { url } = await pedirEnlace(escenario);
    const token = tokenDeLaUrl(url);

    const fila = exigirFilaDeVerificacion(escenario, token);
    // El token pertenece al usuario dado de alta, no a un texto arbitrario.
    expect(fila.value).toBe(idDelUsuario(escenario));

    const restante = fila.expiresAt.getTime() - Date.now();
    expect(restante).toBeGreaterThan((EXPIRACION_SEGUNDOS - HOLGURA_SEGUNDOS) * 1000);
    expect(restante).toBeLessThanOrEqual(EXPIRACION_SEGUNDOS * 1000);
  });

  it("caso 7 — un token inexistente se rechaza sin cambiar la contraseña", async () => {
    const escenario = crearEscenario();
    await crearCuenta(escenario);
    const tokenInventado = "token-que-nunca-existio-0123456789";

    const error = await capturarError(
      escenario.auth.api.resetPassword({
        body: { newPassword: PASSWORD_NUEVA, token: tokenInventado },
      })
    );

    expect(error).toBeInstanceOf(Error);
    expect(codigoDeError(error)).toBe("INVALID_TOKEN");
    // Nada en el error revela el token probado ni por qué falló.
    expect(volcadoDelError(error)).not.toContain(tokenInventado);
    expect(volcadoDelError(error)).not.toContain("expir");

    expect(await puedeEntrar(escenario, PASSWORD_VIEJA)).toBe(true);
    expect(await puedeEntrar(escenario, PASSWORD_NUEVA)).toBe(false);
  });

  it("caso 7 — un token expirado se rechaza y la contraseña anterior sigue sirviendo", async () => {
    const escenario = crearEscenario();
    await crearCuenta(escenario);
    const { url } = await pedirEnlace(escenario);
    const token = tokenDeLaUrl(url);

    // Envejece el enlace como lo haría el reloj: la fila queda caducada.
    exigirFilaDeVerificacion(escenario, token).expiresAt = new Date(
      Date.now() - 1000
    );

    const error = await capturarError(
      escenario.auth.api.resetPassword({
        body: { newPassword: PASSWORD_NUEVA, token },
      })
    );

    expect(error).toBeInstanceOf(Error);
    expect(codigoDeError(error)).toBe("INVALID_TOKEN");
    expect(volcadoDelError(error)).not.toContain(token);

    expect(await puedeEntrar(escenario, PASSWORD_VIEJA)).toBe(true);
    expect(await puedeEntrar(escenario, PASSWORD_NUEVA)).toBe(false);
  });

  it("caso 6 — tras el cambio, la sesión abierta antes del reset queda revocada", async () => {
    const escenario = crearEscenario();
    await crearCuenta(escenario);

    const cabeceras = await iniciarSesionPorHttp(escenario);
    const antes = await escenario.auth.api.getSession({ headers: cabeceras });
    expect(antes?.user.email).toBe(CORREO);

    const { url } = await pedirEnlace(escenario);
    await escenario.auth.api.resetPassword({
      body: { newPassword: PASSWORD_NUEVA, token: tokenDeLaUrl(url) },
    });

    // `revokeSessionsOnPasswordReset: true` borra las sesiones del usuario: la
    // cookie sigue en el navegador, pero ya no resuelve a ninguna sesión.
    expect(await escenario.auth.api.getSession({ headers: cabeceras })).toBeNull();
  });
});

describe("la prueba no deriva de la configuración de producción", () => {
  it("src/lib/auth/index.ts conserva las opciones que este archivo replica", () => {
    const auth = readFileSync(
      resolve(process.cwd(), "src/lib/auth/index.ts"),
      "utf8"
    ).replace(/\r\n/g, "\n");

    // Si alguna cambia en producción, el calco de arriba miente.
    expect(auth).toContain("minPasswordLength: 8");
    expect(auth).toContain(`resetPasswordTokenExpiresIn: ${EXPIRACION_SEGUNDOS}`);
    expect(auth).toContain("revokeSessionsOnPasswordReset: true");
    expect(auth).toContain("sendResetPassword");
  });
});
