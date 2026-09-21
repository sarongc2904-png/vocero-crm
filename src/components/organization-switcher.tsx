"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";

type OrganizationOption = {
  id: string;
  name: string;
  role: string;
  commercialStatus: "trial" | "active" | "past_due" | "suspended" | "cancelled" | null;
  operationalStatus: "configurando" | "listo_para_operar";
};

function statusLabel(status: OrganizationOption["commercialStatus"]) {
  if (status === "active") return "Activo";
  if (status === "trial") return "Demo";
  if (status === "past_due") return "Pago pendiente";
  if (status === "suspended") return "Suspendido";
  if (status === "cancelled") return "Cancelado";
  return "Sin plan";
}

export function OrganizationSwitcher({
  activeOrganizationId,
  canCreate,
}: {
  activeOrganizationId: string;
  canCreate: boolean;
}) {
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/organizations").catch(() => null);
    if (!response?.ok) return;
    const data = (await response.json()) as {
      organizations: OrganizationOption[];
    };
    setOrganizations(data.organizations);
  }, []);

  const switchOrganization = useCallback(
    async (organizationId: string) => {
      if (!organizationId || organizationId === activeOrganizationId) return;
      setBusy(true);
      const response = await fetch("/api/organizations/active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId }),
      }).catch(() => null);
      if (response?.ok) window.location.reload();
      else setBusy(false);
    },
    [activeOrganizationId]
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (
      organizations.length === 0 ||
      organizations.some((organization) => organization.id === activeOrganizationId)
    ) {
      return;
    }

    void switchOrganization(organizations[0].id);
  }, [activeOrganizationId, organizations, switchOrganization]);

  async function createOrganization() {
    const name = window.prompt("Nombre de la nueva organización")?.trim();
    if (!name) return;
    setBusy(true);
    const response = await fetch("/api/organizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).catch(() => null);
    if (response?.ok) window.location.reload();
    else setBusy(false);
  }

  if (organizations.length === 0) return null;

  return (
    <div className="mb-3 flex items-center gap-1 px-2">
      <label className="sr-only" htmlFor="active-organization">
        Organización activa
      </label>
      <select
        id="active-organization"
        value={activeOrganizationId}
        disabled={busy}
        onChange={(event) => void switchOrganization(event.target.value)}
        className="min-w-0 flex-1 rounded-sm border bg-background px-2 py-1.5 text-xs font-semibold"
      >
        {organizations.map((organization) => (
          <option key={organization.id} value={organization.id}>
            {organization.name} · {statusLabel(organization.commercialStatus)}
          </option>
        ))}
      </select>
      {canCreate && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void createOrganization()}
          className="rounded-sm border bg-background p-1.5 text-text-2 hover:bg-accent disabled:opacity-50"
          title="Crear organización"
          aria-label="Crear organización"
        >
          <Plus className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
