import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";
import { MetaApiError, graphRequest } from "@/lib/meta/client";

/**
 * Embedded Signup (modo agencia): el cliente elige su WABA y su número
 * dentro del login oficial de Meta; a nosotros solo nos llega un `code` de un
 * solo uso. Este módulo es la mitad de servidor de ese intercambio — la otra
 * mitad (FB.login, capturar waba_id/phone_number_id del postMessage) vive en
 * el componente de cliente.
 *
 * El `code` NUNCA se cambia por token en el navegador: requiere el App
 * Secret, que no debe salir del servidor (documentado también en el README
 * de Meta para Embedded Signup).
 */

export class EmbeddedSignupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddedSignupError";
  }
}

const SIGNUP_STATE_TTL_MS = 10 * 60 * 1000;

function signupStateSignature(input: {
  sessionId: string;
  organizationId: string;
  expiresAt: number;
  nonce: string;
}): string {
  return createHmac("sha256", getEnv().BETTER_AUTH_SECRET)
    .update(
      `${input.sessionId}\n${input.organizationId}\n${input.expiresAt}\n${input.nonce}`
    )
    .digest("base64url");
}

/** Token CSRF/correlación, corto y ligado a la sesión + tenant activos. */
export function createEmbeddedSignupState(input: {
  sessionId: string;
  organizationId: string;
  now?: number;
}): string {
  const expiresAt = (input.now ?? Date.now()) + SIGNUP_STATE_TTL_MS;
  const nonce = randomBytes(18).toString("base64url");
  const signature = signupStateSignature({ ...input, expiresAt, nonce });
  return `${expiresAt}.${nonce}.${signature}`;
}

export function verifyEmbeddedSignupState(input: {
  state: string;
  sessionId: string;
  organizationId: string;
  now?: number;
}): boolean {
  const [expiresRaw, nonce, signature, extra] = input.state.split(".");
  if (!expiresRaw || !nonce || !signature || extra !== undefined) return false;
  const expiresAt = Number(expiresRaw);
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  if (expiresAt - now > SIGNUP_STATE_TTL_MS) return false;

  const expected = signupStateSignature({
    sessionId: input.sessionId,
    organizationId: input.organizationId,
    expiresAt,
    nonce,
  });
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

/** Intercambia el `code` de un solo uso por un token de acceso de usuario. */
export async function exchangeCodeForToken(code: string): Promise<string> {
  const env = getEnv();
  if (!env.META_APP_ID || !env.META_APP_SECRET) {
    throw new EmbeddedSignupError("Embedded Signup no está configurado en esta instancia");
  }
  const url = new URL(
    `${env.META_GRAPH_BASE_URL}/${env.META_GRAPH_API_VERSION}/oauth/access_token`
  );
  url.searchParams.set("client_id", env.META_APP_ID);
  url.searchParams.set("client_secret", env.META_APP_SECRET);
  url.searchParams.set("code", code);

  const res = await fetch(url.toString());
  const json = (await res.json().catch(() => null)) as
    | { access_token?: string; error?: { message?: string } }
    | null;
  if (!res.ok || !json?.access_token) {
    throw new EmbeddedSignupError(
      json?.error?.message ?? "Meta rechazó el código de Embedded Signup"
    );
  }
  return json.access_token;
}

/**
 * Token de usuario → token de larga duración (~60 días). Best-effort: si
 * falla, se sigue con el corto — más vale una conexión que expira pronto que
 * ninguna.
 */
export async function extendToken(shortLivedToken: string): Promise<string> {
  const env = getEnv();
  if (!env.META_APP_ID || !env.META_APP_SECRET) return shortLivedToken;
  try {
    const url = new URL(
      `${env.META_GRAPH_BASE_URL}/${env.META_GRAPH_API_VERSION}/oauth/access_token`
    );
    url.searchParams.set("grant_type", "fb_exchange_token");
    url.searchParams.set("client_id", env.META_APP_ID);
    url.searchParams.set("client_secret", env.META_APP_SECRET);
    url.searchParams.set("fb_exchange_token", shortLivedToken);
    const res = await fetch(url.toString());
    const json = (await res.json().catch(() => null)) as { access_token?: string } | null;
    return json?.access_token ?? shortLivedToken;
  } catch {
    return shortLivedToken;
  }
}

/**
 * Registra el número en WhatsApp Cloud API si aún no lo está. Necesario tras
 * Embedded Signup para que el número empiece a poder enviar/recibir — Meta lo
 * documenta como paso obligatorio del flujo.
 *
 * Un número ya registrado responde con un error específico que se ignora
 * (best-effort): no es una falla del proceso, es el caso normal cuando el
 * cliente reconecta un número que ya usaba.
 */
export async function registerPhoneNumberIfNeeded(
  phoneNumberId: string,
  token: string
): Promise<void> {
  const pin = String(Math.floor(100000 + Math.random() * 900000));
  try {
    await graphRequest(`${phoneNumberId}/register`, {
      method: "POST",
      token,
      body: { messaging_product: "whatsapp", pin },
    });
  } catch (err) {
    if (err instanceof MetaApiError && err.status >= 400 && err.status < 500) {
      // Ya registrado, o el negocio aún no completó verificación: en ambos
      // casos el resto de la conexión (guardar credenciales) sigue sirviendo.
      console.warn(
        "[embedded-signup] registro de número omitido por respuesta de Meta"
      );
      return;
    }
    throw err;
  }
}
