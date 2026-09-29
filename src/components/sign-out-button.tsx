"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { signOut } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";

/**
 * AUTH-2 — Cerrar sesión desde una pantalla terminal.
 *
 * La pantalla "sin organización" es un callejón sin salida deliberado: el
 * usuario no puede entrar al CRM, pero tampoco debe quedarse encerrado en un
 * formulario de login. Esta es la única acción ofrecida.
 */
export function SignOutButton({ className }: { className?: string }) {
  const router = useRouter();

  return (
    <Button
      type="button"
      variant="outline"
      className={className}
      onClick={async () => {
        await signOut();
        router.push("/login");
        router.refresh();
      }}
    >
      <LogOut className="h-4 w-4" strokeWidth={1.7} />
      Cerrar sesión
    </Button>
  );
}
