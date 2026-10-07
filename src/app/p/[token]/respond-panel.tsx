"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Decision = "aceptar" | "rechazar";
type State =
  | { kind: "idle" }
  | { kind: "confirm"; decision: Decision }
  | { kind: "sending"; decision: Decision }
  | { kind: "done"; status: "aceptada" | "rechazada" }
  | { kind: "error"; message: string };

const MAX_COMMENT = 500;

/**
 * Botones de aceptar/rechazar. Pide confirmación antes de enviar: es una
 * respuesta que no se puede deshacer desde aquí.
 */
export function RespondPanel({ token, businessName }: { token: string; businessName: string }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [comment, setComment] = useState("");

  async function send(decision: Decision) {
    setState({ kind: "sending", decision });
    try {
      const res = await fetch(`/api/p/${encodeURIComponent(token)}/respond`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, comment: comment.trim() || null }),
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      if (res.ok) {
        const body = (await res.json()) as { status: "aceptada" | "rechazada" };
        setState({ kind: "done", status: body.status });
        return;
      }
      if (res.status === 409) {
        setState({ kind: "error", message: "Esta cotización ya no espera respuesta. Recarga la página para ver su estado." });
        return;
      }
      if (res.status === 429) {
        setState({ kind: "error", message: "Demasiados intentos. Espera un minuto y vuelve a intentar." });
        return;
      }
      if (res.status === 404) {
        setState({ kind: "error", message: "Este enlace ya no está disponible." });
        return;
      }
      setState({ kind: "error", message: "No pudimos registrar tu respuesta. Intenta de nuevo." });
    } catch {
      setState({ kind: "error", message: "No pudimos conectar. Revisa tu conexión e intenta de nuevo." });
    }
  }

  if (state.kind === "done") {
    return (
      <div role="status" className="rounded-xl bg-secondary p-4 text-sm">
        {state.status === "aceptada"
          ? `¡Gracias! Aceptaste la cotización. ${businessName} recibió tu respuesta.`
          : `Registramos que rechazaste la cotización. ${businessName} recibió tu respuesta.`}
      </div>
    );
  }

  const pending = state.kind === "confirm" || state.kind === "sending" ? state.decision : null;

  return (
    <div className="space-y-3">
      <label className="block text-sm font-medium" htmlFor="quote-comment">
        Comentario (opcional)
      </label>
      <Textarea
        id="quote-comment"
        value={comment}
        maxLength={MAX_COMMENT}
        onChange={(e) => setComment(e.target.value)}
        placeholder="¿Algo que quieras decirle al negocio?"
        rows={3}
        disabled={state.kind === "sending"}
      />

      {pending ? (
        <div className="rounded-xl border p-4 text-sm">
          <p>
            {pending === "aceptar"
              ? "¿Confirmas que ACEPTAS esta cotización?"
              : "¿Confirmas que RECHAZAS esta cotización?"}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant={pending === "aceptar" ? "default" : "destructive"}
              disabled={state.kind === "sending"}
              onClick={() => send(pending)}
            >
              {state.kind === "sending" ? "Enviando…" : pending === "aceptar" ? "Sí, aceptar" : "Sí, rechazar"}
            </Button>
            <Button variant="outline" disabled={state.kind === "sending"} onClick={() => setState({ kind: "idle" })}>
              Volver
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setState({ kind: "confirm", decision: "aceptar" })}>Aceptar cotización</Button>
          <Button variant="outline" onClick={() => setState({ kind: "confirm", decision: "rechazar" })}>
            Rechazar
          </Button>
        </div>
      )}

      {state.kind === "error" && (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
    </div>
  );
}
