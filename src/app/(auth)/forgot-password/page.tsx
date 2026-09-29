"use client";

import { useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [operationalError, setOperationalError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setOperationalError(null);

    /**
     * AUTH-1 — El cliente de better-auth devuelve `{ data, error }` en vez de
     * lanzar. Antes se ignoraba con `.catch(() => null)` y SIEMPRE se pintaba
     * "recibirás un enlace", incluso si el correo no se había enviado.
     *
     * Mensaje deliberadamente genérico: no revela si la cuenta existe.
     */
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/reset-password`,
    }).catch(() => ({ error: { message: "" } }));

    setLoading(false);

    if (error) {
      setOperationalError(
        "No pudimos procesar la recuperación en este momento. Intenta de nuevo más tarde."
      );
      return;
    }

    setSent(true);
  }

  return (
    <Card className="shadow-md">
      <CardHeader>
        <CardTitle>Recuperar contraseña</CardTitle>
      </CardHeader>
      <CardContent>
        {sent ? (
          <div className="space-y-4">
            <p className="text-sm text-text-2">
              Si existe una cuenta con ese correo, recibirás un enlace para crear una nueva contraseña.
            </p>
            <p className="text-xs text-text-3">El enlace vence en 1 hora.</p>
            <Link href="/login" className="block text-center text-sm font-semibold text-brand-text hover:underline">
              Volver a iniciar sesión
            </Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Correo de acceso</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Enviando…" : "Enviar enlace"}
            </Button>
            {operationalError ? (
              <p
                role="alert"
                className="rounded-md border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-danger-text"
              >
                {operationalError}
              </p>
            ) : null}
            <Link href="/login" className="block text-center text-sm text-text-3 hover:underline">
              Volver
            </Link>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
