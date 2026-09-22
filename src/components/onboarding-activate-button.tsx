"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function OnboardingActivateButton({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function activate() {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/onboarding", { method: "POST" }).catch(
      () => null
    );
    setBusy(false);
    if (!response?.ok) {
      setError("Todavía faltan pasos obligatorios");
      return;
    }
    router.push("/inbox");
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <Button disabled={!enabled || busy} onClick={activate}>
        {busy ? "Activando…" : "Activar y abrir mensajes"}
      </Button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
