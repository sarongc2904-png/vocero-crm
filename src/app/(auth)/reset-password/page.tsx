"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const resetError = searchParams.get("error");

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(
    resetError ? "El enlace de recuperación no es válido o ya venció." : null
  );

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!token) {
      setError("El enlace de recuperación no es válido o ya venció.");
      return;
    }
    if (password.length < 8) {
      setError("La contraseña debe tener al menos 8 caracteres.");
      return;
    }
    if (password !== confirm) {
      setError("Las contraseñas no coinciden.");
      return;
    }

    setLoading(true);
    const result = await authClient.resetPassword({
      newPassword: password,
      token,
    }).catch(() => null);
    setLoading(false);

    if (!result || result.error) {
      setError("No se pudo restablecer la contraseña. Solicita un enlace nuevo.");
      return;
    }

    setDone(true);
  }

  if (done) {
    return (
      <Card className="shadow-md">
        <CardHeader>
          <CardTitle>Contraseña actualizada</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-text-2">
            Ya puedes entrar con tu nueva contraseña.
          </p>
          <Link href="/login" className="block text-center text-sm font-semibold text-brand-text hover:underline">
            Iniciar sesión
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-md">
      <CardHeader>
        <CardTitle>Nueva contraseña</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="password">Nueva contraseña</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-text-3 hover:text-foreground"
                aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="confirm">Confirmar contraseña</Label>
            <div className="relative">
              <Input
                id="confirm"
                type={showConfirm ? "text" : "password"}
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowConfirm((value) => !value)}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-text-3 hover:text-foreground"
                aria-label={showConfirm ? "Ocultar confirmación" : "Mostrar confirmación"}
              >
                {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading || Boolean(resetError)}>
            {loading ? "Guardando…" : "Guardar nueva contraseña"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<p className="text-center text-sm text-text-3">Cargando…</p>}>
      <ResetPasswordForm />
    </Suspense>
  );
}
