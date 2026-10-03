"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SelfServeOrganizationForm() {
  const [businessName, setBusinessName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const response = await fetch("/api/organizations/self-serve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ businessName }),
    }).catch(() => null);
    setSaving(false);
    if (!response?.ok) {
      const body = (await response?.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(body?.error?.message ?? "No se pudo crear la organización");
      return;
    }
    window.location.assign("/");
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-3 rounded-xl border p-4">
      <div className="space-y-1.5">
        <Label htmlFor="required-business-name">Nombre del negocio</Label>
        <Input
          id="required-business-name"
          required
          minLength={2}
          maxLength={120}
          value={businessName}
          onChange={(event) => setBusinessName(event.target.value)}
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={saving || businessName.trim().length < 2}>
        {saving ? "Creando…" : "Crear mi organización"}
      </Button>
    </form>
  );
}
