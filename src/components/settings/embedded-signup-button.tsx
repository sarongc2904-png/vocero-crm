"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  EMBEDDED_SIGNUP_SELECTION_TIMEOUT_MS,
  parseEmbeddedSignupMessage,
} from "@/lib/meta/embedded-signup-message";

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
  state: string;
};

type SelectedNumber = { wabaId: string; phoneNumberId: string };

// Mensajes fijos: nunca se muestra el texto que manda Meta.
const META_ERROR_MESSAGE = "No pudimos completar la conexión con Meta.";
const PARTIAL_MESSAGE =
  "Meta terminó sin un número de WhatsApp para conectar. Intenta de nuevo y elige un número.";
const TIMEOUT_MESSAGE = "Meta no confirmó el número a tiempo. Intenta de nuevo.";

let sdkLoadPromise: Promise<void> | null = null;

/** Carga el SDK de Facebook una sola vez por página, aunque el botón se remonte. */
function loadFacebookSdk(appId: string, version: string): Promise<void> {
  if (window.FB) return Promise.resolve();
  if (sdkLoadPromise) return sdkLoadPromise;

  sdkLoadPromise = new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: true, version });
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://connect.facebook.net/es_LA/sdk.js";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => {
      sdkLoadPromise = null;
      reject(new Error("No se pudo cargar el SDK de Meta"));
    };
    document.body.appendChild(script);
  });
  return sdkLoadPromise;
}

export function EmbeddedSignupButton({
  config,
  onConnected,
  reconnect = false,
}: {
  config: EmbeddedSignupConfig;
  onConnected: (displayPhoneNumber: string) => void;
  reconnect?: boolean;
}) {
  const [status, setStatus] = useState<
    "idle" | "loading_sdk" | "waiting_popup" | "finishing" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<string | null>(null);
  const selectedRef = useRef<SelectedNumber | null>(null);
  const stateRef = useRef(config.state);
  const selectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tras un partial/error/timeout, un callback tardío de FB.login no reabre
  // el intento: hace falta un clic nuevo.
  const attemptClosedRef = useRef(false);

  useEffect(() => {
    stateRef.current = config.state;
  }, [config.state]);

  const clearSelectionTimer = useCallback(() => {
    if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
    selectionTimerRef.current = null;
  }, []);

  useEffect(() => clearSelectionTimer, [clearSelectionTimer]);

  const resetAttempt = useCallback(() => {
    clearSelectionTimer();
    codeRef.current = null;
    selectedRef.current = null;
  }, [clearSelectionTimer]);

  const failAttempt = useCallback(
    (message: string) => {
      resetAttempt();
      attemptClosedRef.current = true;
      setError(message);
      setStatus("error");
    },
    [resetAttempt]
  );

  const tryFinish = useCallback(async () => {
    if (!codeRef.current || !selectedRef.current) return;
    clearSelectionTimer();
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
      body: JSON.stringify({
        code,
        state: stateRef.current,
        wabaId,
        phoneNumberId,
      }),
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
  }, [onConnected, clearSelectionTimer]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const message = parseEmbeddedSignupMessage(event.origin, event.data);
      if (message.kind === "finish") {
        if (attemptClosedRef.current) return;
        selectedRef.current = {
          wabaId: message.wabaId,
          phoneNumberId: message.phoneNumberId,
        };
        void tryFinish();
      } else if (message.kind === "partial") {
        failAttempt(PARTIAL_MESSAGE);
      } else if (message.kind === "cancel") {
        resetAttempt();
        setStatus("idle");
      } else if (message.kind === "error") {
        console.warn(
          `[embedded-signup] meta_error code=${message.errorCode ?? "-"} session=${message.sessionId ?? "-"}`
        );
        failAttempt(META_ERROR_MESSAGE);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [failAttempt, resetAttempt, tryFinish]);

  async function connect() {
    resetAttempt();
    attemptClosedRef.current = false;
    setError(null);
    setStatus("loading_sdk");
    try {
      const stateResponse = await fetch("/api/settings/whatsapp");
      const stateData = (await stateResponse.json().catch(() => null)) as {
        embeddedSignup?: { available?: boolean; state?: string };
      } | null;
      if (!stateResponse.ok || !stateData?.embeddedSignup?.state) {
        throw new Error("No se pudo iniciar una sesión segura");
      }
      stateRef.current = stateData.embeddedSignup.state;
      await loadFacebookSdk(config.appId, config.graphVersion);
    } catch {
      setError("No pudimos cargar Meta. Revisa tu conexión e intenta de nuevo.");
      setStatus("error");
      return;
    }
    setStatus("waiting_popup");
    if (!window.FB) {
      setError("Meta no está disponible en este momento. Intenta de nuevo.");
      setStatus("error");
      return;
    }
    window.FB.login(
      (response) => {
        if (attemptClosedRef.current) return;
        if (!response.authResponse?.code) {
          resetAttempt();
          setStatus("idle");
          return;
        }
        codeRef.current = response.authResponse.code;
        if (!selectedRef.current) {
          // El code vive 30 s: si la selección no llega antes del plazo, se
          // reinicia en vez de dejar el botón en "Conectando…" para siempre.
          clearSelectionTimer();
          selectionTimerRef.current = setTimeout(() => {
            if (codeRef.current && !selectedRef.current) failAttempt(TIMEOUT_MESSAGE);
          }, EMBEDDED_SIGNUP_SELECTION_TIMEOUT_MS);
        }
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
        {busy
          ? "Conectando…"
          : status === "error"
            ? "Intentar de nuevo"
            : reconnect
              ? "Reconectar WhatsApp"
              : "Conectar WhatsApp"}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
