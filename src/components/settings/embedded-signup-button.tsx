"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Botón "Conectar WhatsApp" con Embedded Signup de Meta: el negocio elige su
 * WABA y su número dentro del login oficial de Meta, sin que nadie tenga que
 * copiar un token, un WABA ID ni un Phone Number ID a mano.
 *
 * Dos piezas de información llegan por caminos DISTINTOS y hay que esperar
 * las dos antes de terminar la conexión:
 *   1. `code` — lo entrega el callback de FB.login().
 *   2. `waba_id` / `phone_number_id` — Meta los manda por window.postMessage
 *      mientras el popup sigue abierto (evento "WA_EMBEDDED_SIGNUP").
 * Ver la guía oficial de Embedded Signup de WhatsApp Cloud API.
 */

declare global {
  interface Window {
    FB?: {
      init: (opts: {
        appId: string;
        autoLogAppEvents: boolean;
        xfbml: boolean;
        version: string;
      }) => void;
      login: (
        callback: (response: { authResponse?: { code?: string } | null }) => void,
        opts: {
          config_id: string;
          response_type: string;
          override_default_response_type: boolean;
          extras: { setup: Record<string, never>; featureType: string; sessionInfoVersion: string };
        }
      ) => void;
    };
    fbAsyncInit?: () => void;
  }
}

type EmbeddedSignupConfig = {
  appId: string;
  configId: string;
  graphVersion: string;
};

type SelectedNumber = { wabaId: string; phoneNumberId: string };

let sdkLoadPromise: Promise<void> | null = null;

/** Carga el SDK de Facebook una sola vez por página, aunque el botón se remonte. */
function loadFacebookSdk(appId: string, version: string): Promise<void> {
  if (window.FB) return Promise.resolve();
  if (sdkLoadPromise) return sdkLoadPromise;

  sdkLoadPromise = new Promise((resolve) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: true, version });
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://connect.facebook.net/es_LA/sdk.js";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    document.body.appendChild(script);
  });
  return sdkLoadPromise;
}

export function EmbeddedSignupButton({
  config,
  onConnected,
}: {
  config: EmbeddedSignupConfig;
  onConnected: (displayPhoneNumber: string) => void;
}) {
  const [status, setStatus] = useState<
    "idle" | "loading_sdk" | "waiting_popup" | "finishing" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<string | null>(null);
  const selectedRef = useRef<SelectedNumber | null>(null);

  const tryFinish = useCallback(async () => {
    if (!codeRef.current || !selectedRef.current) return;
    setStatus("finishing");
    const code = codeRef.current;
    const { wabaId, phoneNumberId } = selectedRef.current;
    // Se limpia de inmediato: un remount no debe reintentar con un `code` ya
    // usado (Meta lo invalida al primer intercambio).
    codeRef.current = null;
    selectedRef.current = null;

    const res = await fetch("/api/settings/whatsapp/embedded-signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, wabaId, phoneNumberId }),
    }).catch(() => null);

    if (!res?.ok) {
      const data = (await res?.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(data?.error?.message ?? "No se pudo completar la conexión");
      setStatus("error");
      return;
    }
    const data = (await res.json()) as { displayPhoneNumber: string };
    setStatus("idle");
    onConnected(data.displayPhoneNumber);
  }, [onConnected]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (
        event.origin !== "https://www.facebook.com" &&
        event.origin !== "https://web.facebook.com"
      ) {
        return;
      }
      let data: unknown;
      try {
        data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      const payload = data as {
        type?: string;
        event?: string;
        data?: { waba_id?: string; phone_number_id?: string };
      };
      if (payload?.type !== "WA_EMBEDDED_SIGNUP") return;
      if (payload.event === "FINISH" && payload.data?.waba_id && payload.data?.phone_number_id) {
        selectedRef.current = {
          wabaId: payload.data.waba_id,
          phoneNumberId: payload.data.phone_number_id,
        };
        void tryFinish();
      } else if (payload.event === "CANCEL") {
        setStatus("idle");
      } else if (payload.event === "ERROR") {
        setError("Meta reportó un error durante la conexión");
        setStatus("error");
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [tryFinish]);

  async function connect() {
    setError(null);
    setStatus("loading_sdk");
    await loadFacebookSdk(config.appId, config.graphVersion);
    setStatus("waiting_popup");
    window.FB!.login(
      (response) => {
        if (!response.authResponse?.code) {
          setStatus("idle");
          return;
        }
        codeRef.current = response.authResponse.code;
        void tryFinish();
      },
      {
        config_id: config.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
      }
    );
  }

  const busy = status === "loading_sdk" || status === "waiting_popup" || status === "finishing";

  return (
    <div className="space-y-2">
      <Button onClick={() => void connect()} disabled={busy} size="lg">
        {busy ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <MessageCircle className="mr-2 h-4 w-4" />
        )}
        {status === "finishing" ? "Conectando…" : "Conectar WhatsApp"}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
