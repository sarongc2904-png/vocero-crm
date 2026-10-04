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

/** Intercambia el `code` de un solo uso por el token de acceso de Embedded Signup. */
export async function exchangeCodeForToken(
  code: string,
  signal?: AbortSignal
): Promise<string> {
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

  const res = await fetch(url.toString(), signal ? { signal } : undefined);
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
 * PIN de verificación en dos pasos con el que se registra el número.
 *
 * Determinista: HMAC-SHA256 del secreto del servidor sobre el phone_number_id
 * (con separación de dominio), reducido a 6 dígitos. Así el mismo número
 * siempre recibe el mismo PIN y puede volver a calcularse para un re-registro
 * o una migración, sin guardarlo en base de datos. Un PIN aleatorio que nadie
 * conserva dejaba al número con una verificación en dos pasos imposible de
 * recuperar.
 */
export function deriveRegistrationPin(phoneNumberId: string, secret: string): string {
  const digest = createHmac("sha256", secret)
    .update(`whatsapp-registration-pin:v1:${phoneNumberId}`)
    .digest();
  return String(100000 + (digest.readUInt32BE(0) % 900000));
}

export function registrationPinFor(phoneNumberId: string): string {
  return deriveRegistrationPin(phoneNumberId, getEnv().ENCRYPTION_KEY);
}

/**
 * Registra el número en WhatsApp Cloud API si aún no lo está. Necesario tras
 * Embedded Signup para que el número empiece a poder enviar/recibir — Meta lo
 * documenta como paso obligatorio del flujo.
 *
 * Meta documenta 133006 como número que necesita reverificación. No se
 * interpreta ningún otro 4xx por texto: sin un código documentado, falla
 * cerrado. Un registro o re-registro aceptado responde success=true.
 */
export type PhoneRegistrationResult =
  | { status: "registered" }
  | { status: "pending"; code: "phone_verification_pending" }
  | {
      status: "failed";
      code:
        | "phone_registration_failed"
        | "registration_pin_invalid"
        | "registration_attempts_exceeded"
        | "meta_unavailable"
        | "meta_timeout";
    };

export class EmbeddedSignupTimeoutError extends EmbeddedSignupError {
  constructor() {
    super("Meta tardó demasiado en responder. Intenta nuevamente.");
    this.name = "EmbeddedSignupTimeoutError";
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function safeDiagnosticValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "string" && /^\d{1,10}$/.test(value)) return value;
  return undefined;
}

function safeTraceId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
    ? value
    : undefined;
}

function logMetaDiagnostics(err: MetaApiError): void {
  const details = err.details as
    | { error?: { error_subcode?: unknown; fbtrace_id?: unknown } }
    | null;
  const diagnostic = {
    error_code: safeDiagnosticValue(err.code),
    subcode: safeDiagnosticValue(details?.error?.error_subcode),
    fbtrace_id: safeTraceId(details?.error?.fbtrace_id),
  };
  console.warn("[embedded-signup]", diagnostic);
}

export async function registerPhoneNumberIfNeeded(
  phoneNumberId: string,
  token: string,
  signal?: AbortSignal
): Promise<PhoneRegistrationResult> {
  try {
    const phone = await graphRequest<{
      status?: string;
      code_verification_status?: string;
    }>(`${phoneNumberId}?fields=status,code_verification_status`, {
      token,
      signal,
    });
    if (phone.status === "CONNECTED") return { status: "registered" };
    if (
      phone.status === "PENDING" ||
      phone.status === "UNVERIFIED" ||
      phone.code_verification_status === "UNVERIFIED"
    ) {
      return { status: "pending", code: "phone_verification_pending" };
    }
    if (
      phone.status !== "DISCONNECTED" ||
      phone.code_verification_status !== "VERIFIED"
    ) {
      return { status: "failed", code: "phone_registration_failed" };
    }

    const pin = registrationPinFor(phoneNumberId);
    const result = await graphRequest<{ success?: boolean | string }>(
      `${phoneNumberId}/register`,
      {
        method: "POST",
        token,
        body: { messaging_product: "whatsapp", pin },
        signal,
      }
    );
    return result?.success === true || result?.success === "true"
      ? { status: "registered" }
      : { status: "failed", code: "phone_registration_failed" };
  } catch (err) {
    if (isAbortError(err)) {
      return { status: "failed", code: "meta_timeout" };
    }
    if (err instanceof MetaApiError) {
      logMetaDiagnostics(err);
      if (err.code === 133005) {
        return { status: "failed", code: "registration_pin_invalid" };
      }
      if (err.code === 133016) {
        return { status: "failed", code: "registration_attempts_exceeded" };
      }
      if (err.code === 133006) {
        return { status: "pending", code: "phone_verification_pending" };
      }
      if (err.status === 0 || err.status >= 500) {
        return { status: "failed", code: "meta_unavailable" };
      }
    }
    return { status: "failed", code: "phone_registration_failed" };
  }
}

type WabaPhoneNumbersPage = {
  data?: Array<{ id?: string }>;
  paging?: {
    cursors?: { after?: unknown };
    next?: unknown;
  };
};

/** Verifica token↔WABA↔número recorriendo todas las páginas de Graph. */
export async function verifyPhoneNumberBelongsToWaba(
  wabaId: string,
  phoneNumberId: string,
  token: string,
  signal?: AbortSignal
): Promise<boolean> {
  let path = `${encodeURIComponent(wabaId)}/phone_numbers?fields=id&limit=100`;
  const seenCursors = new Set<string>();
  let pageCount = 0;

  try {
    while (true) {
      if (pageCount >= 10) {
        throw new EmbeddedSignupError(
          "No pudimos verificar el número con Meta. Intenta nuevamente."
        );
      }
      pageCount += 1;
      const page = await graphRequest<WabaPhoneNumbersPage>(path, {
        token,
        signal,
      });
      if (page.data?.some((phone) => phone.id === phoneNumberId)) return true;
      if (!page.paging?.next) return false;

      const after = page.paging.cursors?.after;
      if (
        typeof after !== "string" ||
        after.length === 0 ||
        after.length > 2048 ||
        seenCursors.has(after)
      ) {
        throw new EmbeddedSignupError(
          "No pudimos verificar el número con Meta. Intenta nuevamente."
        );
      }
      seenCursors.add(after);
      path = `${encodeURIComponent(wabaId)}/phone_numbers?fields=id&limit=100&after=${encodeURIComponent(after)}`;
    }
  } catch (err) {
    if (isAbortError(err)) throw new EmbeddedSignupTimeoutError();
    if (err instanceof MetaApiError) logMetaDiagnostics(err);
    if (err instanceof EmbeddedSignupError) throw err;
    throw new EmbeddedSignupError(
      "No pudimos verificar el número con Meta. Intenta nuevamente."
    );
  }
}
