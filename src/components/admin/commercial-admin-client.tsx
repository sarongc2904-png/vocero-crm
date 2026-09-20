"use client";

import { useEffect, useMemo, useState } from "react";

type Account = {
  organizationId: string;
  organizationName: string;
  organizationSlug: string | null;
  createdAt: string;
  entitlementId: string | null;
  status: "trial" | "active" | "past_due" | "suspended" | "cancelled" | null;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  currentPeriodEndsAt: string | null;
  planId: string | null;
  planCode: string | null;
  planName: string | null;
  monthlyPriceCents: number | null;
  currency: string | null;
  trialDays: number | null;
};

type Plan = {
  id: string;
  code: string;
  name: string;
  monthlyPriceCents: number;
  currency: string;
  trialDays: number;
  active: boolean;
};

function money(cents: number | null, currency: string | null) {
  if (cents == null || !currency) return "—";
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function date(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function CommercialAdminClient() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/commercial", { cache: "no-store" });
      if (!res.ok) throw new Error("No se pudo cargar el panel");
      const data = await res.json();
      setAccounts(data.accounts ?? []);
      setPlans(data.plans ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function mutate(
    organizationId: string,
    action: string,
    extra: Record<string, unknown> = {}
  ) {
    setBusy(organizationId);
    try {
      const res = await fetch("/api/admin/commercial", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, action, ...extra }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message ?? "No se pudo actualizar");
      }
      await load();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "No se pudo actualizar");
    } finally {
      setBusy(null);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter((account) =>
      [account.organizationName, account.organizationSlug, account.status, account.planName]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q))
    );
  }, [accounts, query]);

  if (loading) {
    return <p className="text-sm text-text-3">Cargando clientes…</p>;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="kicker text-brand-text">Administración comercial</p>
          <h1 className="mt-1 text-2xl font-bold">Clientes y planes</h1>
          <p className="mt-1 text-sm text-text-3">
            Extiende demos, activa, suspende, cancela, reactiva o cambia de plan.
          </p>
        </div>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar cliente"
          className="h-10 rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-brand"
        />
      </div>

      <div className="overflow-x-auto rounded-xl border">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-subtle text-text-3">
            <tr>
              <th className="px-4 py-3 font-semibold">Cliente</th>
              <th className="px-4 py-3 font-semibold">Plan</th>
              <th className="px-4 py-3 font-semibold">Estado</th>
              <th className="px-4 py-3 font-semibold">Trial / periodo</th>
              <th className="px-4 py-3 font-semibold">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.map((account) => {
              const disabled = busy === account.organizationId;
              return (
                <tr key={account.organizationId} className="align-top">
                  <td className="px-4 py-4">
                    <div className="font-semibold">{account.organizationName}</div>
                    <div className="mt-1 font-mono text-xs text-text-3">
                      {account.organizationSlug ?? account.organizationId}
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <select
                      value={account.planId ?? ""}
                      disabled={disabled}
                      onChange={(event) =>
                        void mutate(account.organizationId, "change_plan", {
                          planId: event.target.value,
                        })
                      }
                      className="h-9 rounded-md border bg-background px-2 text-sm"
                    >
                      <option value="" disabled>Sin plan</option>
                      {plans.map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {plan.name} · {money(plan.monthlyPriceCents, plan.currency)}
                        </option>
                      ))}
                    </select>
                    <div className="mt-1 text-xs text-text-3">
                      {money(account.monthlyPriceCents, account.currency)} / mes
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <span className="inline-flex rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold capitalize">
                      {account.status ?? "sin entitlement"}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-xs text-text-3">
                    <div>Trial: {date(account.trialEndsAt)}</div>
                    <div className="mt-1">Periodo: {date(account.currentPeriodEndsAt)}</div>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex min-w-[20rem] flex-wrap gap-2">
                      <button
                        disabled={disabled}
                        onClick={() => {
                          const raw = window.prompt("¿Cuántos días quieres extender?", "3");
                          if (!raw) return;
                          const days = Number(raw);
                          if (!Number.isInteger(days) || days < 1 || days > 365) {
                            window.alert("Usa un número entero entre 1 y 365");
                            return;
                          }
                          void mutate(account.organizationId, "extend_trial", { days });
                        }}
                        className="rounded-md border px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50"
                      >
                        Extender demo
                      </button>
                      <button
                        disabled={disabled}
                        onClick={() => void mutate(account.organizationId, "activate")}
                        className="rounded-md border px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50"
                      >
                        Activar
                      </button>
                      <button
                        disabled={disabled}
                        onClick={() => void mutate(account.organizationId, "suspend")}
                        className="rounded-md border px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50"
                      >
                        Suspender
                      </button>
                      <button
                        disabled={disabled}
                        onClick={() => void mutate(account.organizationId, "reactivate")}
                        className="rounded-md border px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50"
                      >
                        Reactivar
                      </button>
                      <button
                        disabled={disabled}
                        onClick={() => {
                          if (window.confirm("¿Cancelar este plan? Los datos se conservarán.")) {
                            void mutate(account.organizationId, "cancel");
                          }
                        }}
                        className="rounded-md border px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50"
                      >
                        Cancelar
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <p className="p-6 text-center text-sm text-text-3">No hay clientes que coincidan.</p>
        )}
      </div>
    </div>
  );
}
