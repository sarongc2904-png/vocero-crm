import { graphRequest, MetaApiError } from "@/lib/meta/client";

export type ConnectionCheck =
  | {
      ok: true;
      displayPhoneNumber: string;
      verifiedName: string | null;
    }
  | {
      ok: false;
      code: "invalid_token" | "meta_unavailable" | "meta_timeout" | "meta_error";
      message: string;
    };

/**
 * Valida token↔número contra la Graph API SIN persistir nada (FR-040):
 * un GET del número con el token debe devolver su display_phone_number.
 */
export async function testConnection(
  phoneNumberId: string,
  token: string,
  signal?: AbortSignal
): Promise<ConnectionCheck> {
  try {
    const res = await graphRequest<{
      display_phone_number?: string;
      verified_name?: string;
      id: string;
    }>(`${phoneNumberId}?fields=display_phone_number,verified_name`, {
      token,
      signal,
    });
    if (!res.display_phone_number) {
      return {
        ok: false,
        code: "meta_error",
        message:
          "Meta no devolvió el número: verifica que el Phone Number ID sea correcto",
      };
    }
    return {
      ok: true,
      displayPhoneNumber: res.display_phone_number,
      verifiedName: res.verified_name ?? null,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        code: "meta_timeout",
        message: "Meta tardó demasiado en responder. Intenta nuevamente.",
      };
    }
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        return {
          ok: false,
          code: "invalid_token",
          message:
            "El token no es válido o expiró. Verifica que corresponde a este número (modo directo: token de usuario del sistema; modo agencia: token entregado por tu backend).",
        };
      }
      if (err.status === 0 || err.status >= 500) {
        return {
          ok: false,
          code: "meta_unavailable",
          message: "Meta no está disponible en este momento; intenta de nuevo",
        };
      }
      return {
        ok: false,
        code: "meta_error",
        message:
          "Meta rechazó la verificación del número. Revisa la configuración e intenta nuevamente.",
      };
    }
    throw err;
  }
}

/**
 * Suscribe la app a la WABA tras guardar (necesario para recibir webhooks en
 * modo directo). Best-effort: en modo agencia el override lo configura el
 * backend de la agencia y esta llamada puede no aplicar.
 */
export async function subscribeAppToWaba(
  wabaId: string,
  token: string,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    await graphRequest(`${wabaId}/subscribed_apps`, {
      method: "POST",
      token,
      signal,
    });
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    console.warn(
      "[connect] subscribed_apps falló (esperado en modo agencia)"
    );
    return false;
  }
}
