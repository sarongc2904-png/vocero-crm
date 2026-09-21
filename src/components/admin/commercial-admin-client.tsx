"use client";

import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

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
  operationalStatus:
    | "por_configurar"
    | "configurando"
    | "listo_para_activar"
    | "listo_para_operar";
  requiredCompleted: number;
  requiredTotal: number;
  nextRequiredStep: string | null;
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
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "trial" | "inactive">("all");
  const [showCreateClient, setShowCreateClient] = useState(false);

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

  async function mutateAccount(
    organizationId: string,
    action: string,
    extra: Record<string, unknown> = {}
  ) {
    setBusy(organizationId);
    try {
      const res = await fetch("/api/admin/commercial", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: "account",
          organizationId,
          action,
          ...extra,
        }),
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

  async function mutatePlan(plan: Plan, pricePesos: number, trialDays: number) {
    setBusy(plan.id);
    try {
      const res = await fetch("/api/admin/commercial", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: "plan",
          planId: plan.id,
          monthlyPriceCents: Math.round(pricePesos * 100),
          trialDays,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message ?? "No se pudo actualizar el plan");
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
    return accounts.filter((account) => {
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && account.status === "active") ||
        (statusFilter === "trial" && account.status === "trial") ||
        (statusFilter === "inactive" &&
          (account.status === "past_due" ||
            account.status === "suspended" ||
            account.status === "cancelled"));

      if (!matchesStatus) return false;
      if (!q) return true;

      return [account.organizationName, account.organizationSlug, account.status, account.planName]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    });
  }, [accounts, query, statusFilter]);

  if (loading) {
    return <p className="text-sm text-text-3">Cargando clientes…</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="kicker text-brand-text">Administración comercial</p>
          <h1 className="mt-1 text-2xl font-bold">Clientes y planes</h1>
          <p className="mt-1 text-sm text-text-3">
            Controla precio, demo, estado y plan sin entrar a PostgreSQL. Desactivar conserva todos los datos y quita el acceso hasta que reactives al cliente.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => setShowCreateClient((value) => !value)}
            className="h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-brand-fg"
          >
            {showCreateClient ? "Cerrar alta" : "+ Crear cliente"}
          </button>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar cliente"
            className="h-10 rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-brand"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {([
          ["all", "Todos"],
          ["active", "Activos"],
          ["trial", "Demo"],
          ["inactive", "Inactivos"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setStatusFilter(value)}
            className={
              statusFilter === value
                ? "rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-fg"
                : "rounded-md border bg-background px-3 py-1.5 text-xs font-semibold text-text-2 hover:bg-accent"
            }
          >
            {label}
          </button>
        ))}
      </div>

      {showCreateClient && (
        <ClientCreator
          plans={plans}
          busy={busy === "create-client"}
          onBusy={setBusy}
          onCreated={async () => {
            await load();
          }}
        />
      )}

      <section className="rounded-xl border p-4">
        <h2 className="text-base font-bold">Configuración de planes</h2>
        <p className="mt-1 text-sm text-text-3">
          El precio se actualiza para todos los clientes asignados a ese plan. Los días de demo aplican a altas nuevas; los trials ya iniciados conservan su fecha hasta que los extiendas manualmente.
        </p>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {plans.map((plan) => (
            <PlanEditor
              key={plan.id}
              plan={plan}
              disabled={busy === plan.id}
              onSave={mutatePlan}
            />
          ))}
        </div>
      </section>

      <div className="overflow-x-auto rounded-xl border">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-subtle text-text-3">
            <tr>
              <th className="px-4 py-3 font-semibold">Cliente</th>
              <th className="px-4 py-3 font-semibold">Plan</th>
              <th className="px-4 py-3 font-semibold">Estado</th>
              <th className="px-4 py-3 font-semibold">Operación</th>
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
                        void mutateAccount(account.organizationId, "change_plan", {
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
                  <td className="px-4 py-4">
                    <div className="text-xs font-semibold">
                      {account.operationalStatus === "listo_para_operar"
                        ? "Listo para operar"
                        : account.operationalStatus === "listo_para_activar"
                          ? "Listo para activar"
                          : account.operationalStatus === "configurando"
                            ? "Configurando"
                            : "Por configurar"}
                    </div>
                    <div className="mt-1 text-xs text-text-3">
                      {account.requiredCompleted}/{account.requiredTotal} requisitos
                    </div>
                    {account.nextRequiredStep && (
                      <div className="mt-1 text-xs text-text-3">
                        Siguiente: {account.nextRequiredStep}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-4 text-xs text-text-3">
                    <div>Trial: {date(account.trialEndsAt)}</div>
                    <div className="mt-1">Periodo: {date(account.currentPeriodEndsAt)}</div>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex min-w-[20rem] flex-wrap gap-2">
                      {account.status === "trial" && (
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
                            void mutateAccount(account.organizationId, "extend_trial", { days });
                          }}
                          className="rounded-md border px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50"
                        >
                          Extender demo
                        </button>
                      )}
                      {(account.status === "trial" || account.status === "past_due") && (
                        <button
                          disabled={disabled}
                          onClick={() => void mutateAccount(account.organizationId, "activate")}
                          className="rounded-md border px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50"
                        >
                          Activar
                        </button>
                      )}
                      {account.status !== "suspended" && account.status !== "cancelled" && (
                        <button
                          disabled={disabled}
                          onClick={() => {
                            if (window.confirm("¿Desactivar el acceso de este cliente? Sus datos se conservarán y podrás reactivarlo después.")) {
                              void mutateAccount(account.organizationId, "suspend");
                            }
                          }}
                          className="rounded-md border px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50"
                        >
                          Desactivar acceso
                        </button>
                      )}
                      {(account.status === "suspended" || account.status === "cancelled") && (
                        <button
                          disabled={disabled}
                          onClick={() => void mutateAccount(account.organizationId, "reactivate")}
                          className="rounded-md border px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50"
                        >
                          Reactivar
                        </button>
                      )}
                      {account.status !== "cancelled" && (
                        <button
                          disabled={disabled}
                          onClick={() => {
                            if (window.confirm("¿Cancelar este plan? Los datos se conservarán.")) {
                              void mutateAccount(account.organizationId, "cancel");
                            }
                          }}
                          className="rounded-md border px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50"
                        >
                          Cancelar
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <p className="p-6 text-center text-sm text-text-3">
            No hay clientes que coincidan.
          </p>
        )}
      </div>
    </div>
  );
}

function ClientCreator({
  plans,
  busy,
  onBusy,
  onCreated,
}: {
  plans: Plan[];
  busy: boolean;
  onBusy: (value: string | null) => void;
  onCreated: () => Promise<void>;
}) {
  const defaultPlan = plans.find((plan) => plan.active) ?? plans[0] ?? null;
  const [businessName, setBusinessName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [planId, setPlanId] = useState(defaultPlan?.id ?? "");
  const [trialDays, setTrialDays] = useState(
    defaultPlan ? String(defaultPlan.trialDays) : "3"
  );
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    email: string;
    password: string;
    businessName: string;
  } | null>(null);

  useEffect(() => {
    if (!planId && defaultPlan) {
      setPlanId(defaultPlan.id);
      setTrialDays(String(defaultPlan.trialDays));
    }
  }, [defaultPlan, planId]);

  function generatePassword() {
    const alphabet =
      "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = new Uint32Array(14);
    crypto.getRandomValues(bytes);
    setPassword(
      Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("")
    );
  }

  async function createClient() {
    setError(null);
    setCreated(null);
    const days = Number(trialDays);
    if (!Number.isInteger(days) || days < 0 || days > 365) {
      setError("Los días de demo deben estar entre 0 y 365");
      return;
    }

    onBusy("create-client");
    try {
      const res = await fetch("/api/admin/commercial", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessName,
          ownerName,
          email,
          password,
          planId,
          trialDays: days,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error?.message ?? "No se pudo crear el cliente");
      }
      setCreated({ email, password, businessName });
      setBusinessName("");
      setOwnerName("");
      setEmail("");
      setPassword("");
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el cliente");
    } finally {
      onBusy(null);
    }
  }

  const canCreate =
    businessName.trim().length >= 2 &&
    ownerName.trim().length >= 2 &&
    email.includes("@") &&
    password.length >= 8 &&
    Boolean(planId);

  return (
    <section className="rounded-xl border border-brand-soft bg-brand-tint p-4">
      <div>
        <p className="kicker text-brand-text">Alta controlada</p>
        <h2 className="mt-1 text-base font-bold">Crear nuevo cliente</h2>
        <p className="mt-1 text-sm text-text-3">
          Crea el propietario, la organización, el plan, el trial, el onboarding,
          el perfil del agente y el pipeline inicial en una sola operación.
        </p>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="text-xs font-semibold text-text-2">
          Nombre del negocio
          <input
            value={businessName}
            onChange={(event) => setBusinessName(event.target.value)}
            placeholder="Clínica XYZ"
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm font-normal"
          />
        </label>
        <label className="text-xs font-semibold text-text-2">
          Nombre del propietario
          <input
            value={ownerName}
            onChange={(event) => setOwnerName(event.target.value)}
            placeholder="María López"
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm font-normal"
          />
        </label>
        <label className="text-xs font-semibold text-text-2">
          Correo de acceso
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="maria@negocio.com"
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm font-normal"
          />
        </label>
        <label className="text-xs font-semibold text-text-2">
          Contraseña temporal
          <div className="mt-1 flex gap-2">
            <div className="relative min-w-0 flex-1">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="mínimo 8 caracteres"
                className="h-10 w-full rounded-md border bg-background px-3 pr-10 text-sm font-normal"
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-text-3 hover:text-foreground"
                aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                title={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            <button
              type="button"
              onClick={generatePassword}
              className="rounded-md border bg-background px-3 text-xs font-semibold"
            >
              Generar
            </button>
          </div>
        </label>
        <label className="text-xs font-semibold text-text-2">
          Plan
          <select
            value={planId}
            onChange={(event) => {
              const next = event.target.value;
              setPlanId(next);
              const plan = plans.find((item) => item.id === next);
              if (plan) setTrialDays(String(plan.trialDays));
            }}
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm font-normal"
          >
            <option value="" disabled>Selecciona un plan</option>
            {plans.filter((plan) => plan.active).map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name} · {money(plan.monthlyPriceCents, plan.currency)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-semibold text-text-2">
          Días de demo
          <input
            type="number"
            min="0"
            max="365"
            step="1"
            value={trialDays}
            onChange={(event) => setTrialDays(event.target.value)}
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm font-normal"
          />
        </label>
      </div>

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      {created && (
        <div className="mt-3 rounded-md border border-success-soft bg-success-tint p-3 text-sm">
          <p className="font-semibold text-success-text">Cliente creado ✓</p>
          <p className="mt-1 text-success-text opacity-90">
            Acceso: <code>{created.email}</code> · contraseña temporal{" "}
            <code>{created.password}</code>
          </p>
          <p className="mt-1 text-xs text-success-text opacity-80">
            Comparte estas credenciales ahora; la contraseña no se almacena en texto plano.
          </p>
        </div>
      )}

      <button
        type="button"
        disabled={!canCreate || busy}
        onClick={() => void createClient()}
        className="mt-4 rounded-md bg-brand px-4 py-2 text-sm font-semibold text-brand-fg disabled:opacity-50"
      >
        {busy ? "Creando cliente…" : "Crear cliente"}
      </button>
    </section>
  );
}

function PlanEditor({
  plan,
  disabled,
  onSave,
}: {
  plan: Plan;
  disabled: boolean;
  onSave: (plan: Plan, pricePesos: number, trialDays: number) => Promise<void>;
}) {
  const [price, setPrice] = useState(String(plan.monthlyPriceCents / 100));
  const [trialDays, setTrialDays] = useState(String(plan.trialDays));

  useEffect(() => {
    setPrice(String(plan.monthlyPriceCents / 100));
    setTrialDays(String(plan.trialDays));
  }, [plan.monthlyPriceCents, plan.trialDays]);

  return (
    <div className="rounded-lg bg-subtle p-4">
      <div className="font-semibold">{plan.name}</div>
      <div className="mt-1 text-xs text-text-3">{plan.code}</div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <label className="text-xs font-semibold text-text-2">
          Precio mensual
          <input
            type="number"
            min="0"
            step="1"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm font-normal"
          />
        </label>
        <label className="text-xs font-semibold text-text-2">
          Días de demo
          <input
            type="number"
            min="0"
            max="365"
            step="1"
            value={trialDays}
            onChange={(event) => setTrialDays(event.target.value)}
            className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm font-normal"
          />
        </label>
      </div>
      <button
        disabled={disabled}
        onClick={() => {
          const priceValue = Number(price);
          const daysValue = Number(trialDays);
          if (!Number.isFinite(priceValue) || priceValue < 0) {
            window.alert("El precio no es válido");
            return;
          }
          if (!Number.isInteger(daysValue) || daysValue < 0 || daysValue > 365) {
            window.alert("Los días de demo deben estar entre 0 y 365");
            return;
          }
          void onSave(plan, priceValue, daysValue);
        }}
        className="mt-3 rounded-md border px-3 py-2 text-xs font-semibold disabled:opacity-50"
      >
        Guardar plan
      </button>
    </div>
  );
}
