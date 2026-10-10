"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatQuoteDate } from "@/lib/quote-format";

export type LatestSend = {
  id: string;
  status: "pendiente" | "enviado" | "fallido" | "incierto";
  mode: "documento" | "plantilla" | null;
  errorMessage: string | null;
  createdAt: string;
};

type Phase =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "failed"; message: string }
  /** No hubo respuesta del servidor: el reintento reusa la MISMA clave. */
  | { kind: "network"; message: string };

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * "Enviar por WhatsApp". El botón se desactiva en el PRIMER clic (antes de
 * cualquier await) y cada clic lleva su `Idempotency-Key`; si la red falla,
 * "Reintentar" reusa la misma clave, así que el servidor nunca manda dos.
 */
export function WhatsAppSendPanel({ quoteId, latest }: { quoteId: string; latest: LatestSend | null }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const inFlight = useRef(false);
  const pendingKey = useRef<string | null>(null);
  const [resolving, setResolving] = useState(false);

  async function send(reuseKey: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase({ kind: "sending" });
    const key = reuseKey && pendingKey.current ? pendingKey.current : newKey();
    pendingKey.current = key;
    try {
      const res = await fetch(`/api/quotes/${quoteId}/send`, {
        method: "POST",
        headers: { "idempotency-key": key },
        cache: "no-store",
      });
      const data = (await res.json().catch(() => null)) as {
        send?: LatestSend;
        error?: { message?: string };
      } | null;
      pendingKey.current = null;
      if (res.status === 200) setPhase({ kind: "sent" });
      else if (data?.send?.status === "fallido") setPhase({ kind: "failed", message: data.send.errorMessage ?? "No se pudo enviar" });
      else setPhase({ kind: "failed", message: data?.error?.message ?? "No se pudo enviar" });
      router.refresh();
    } catch {
      setPhase({ kind: "network", message: "Se perdió la conexión. Reintentar no enviará el mensaje dos veces." });
    } finally {
      inFlight.current = false;
    }
  }

  async function resolve(outcome: "llego" | "no_llego") {
    if (!latest) return;
    const text =
      outcome === "llego"
        ? "¿Confirmas que el cliente SÍ recibió la cotización? Quedará como enviada."
        : "¿Confirmas que NO llegó? El enlace de ese intento dejará de funcionar y podrás reenviarla.";
    if (!window.confirm(text)) return;
    setResolving(true);
    try {
      const res = await fetch(`/api/quotes/${quoteId}/send/${latest.id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setPhase({ kind: "failed", message: data?.error?.message ?? "No se pudo registrar" });
      } else {
        setPhase({ kind: "idle" });
      }
      router.refresh();
    } finally {
      setResolving(false);
    }
  }

  const pendingOnServer = latest?.status === "pendiente";
  const uncertain = latest?.status === "incierto";
  const busy = phase.kind === "sending" || pendingOnServer || resolving;

  return (
    <section className="space-y-3 rounded-xl border p-4" aria-live="polite">
      <h3 className="font-semibold">Enviar por WhatsApp</h3>
      <p className="text-sm text-text-3">
        Dentro de las 24 h del último mensaje del cliente se manda el PDF con el enlace. Fuera de esa ventana se usa la
        plantilla elegida en Ajustes de cotizaciones.
      </p>

      {uncertain ? (
        <div role="alert" className="space-y-2 rounded-md bg-warning-tint p-3 text-sm text-warning-text">
          <p>
            Un envío del {formatQuoteDate(latest!.createdAt)} quedó sin confirmar. Revisa la conversación: ¿le llegó al
            cliente? No se reenviará nada hasta que lo indiques.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => resolve("llego")} disabled={resolving}>
              Sí llegó
            </Button>
            <Button size="sm" variant="outline" onClick={() => resolve("no_llego")} disabled={resolving}>
              No llegó
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {phase.kind === "network" ? (
            <Button onClick={() => send(true)} disabled={busy}>
              <Send className="h-4 w-4" /> Reintentar envío
            </Button>
          ) : (
            <Button onClick={() => send(false)} disabled={busy || phase.kind === "sent"}>
              <Send className="h-4 w-4" />
              {phase.kind === "sending" || pendingOnServer ? "Enviando…" : "Enviar por WhatsApp"}
            </Button>
          )}
        </div>
      )}

      {phase.kind === "sent" && (
        <p role="status" className="text-sm text-success-text">
          Enviada por WhatsApp. La cotización quedó como enviada.
        </p>
      )}
      {(phase.kind === "failed" || phase.kind === "network") && (
        <p role="alert" className="text-sm text-destructive">
          {phase.message}
        </p>
      )}
      {phase.kind === "idle" && latest?.status === "fallido" && latest.errorMessage && (
        <p className="text-sm text-text-3">Último intento ({formatQuoteDate(latest.createdAt)}): {latest.errorMessage}</p>
      )}
    </section>
  );
}
