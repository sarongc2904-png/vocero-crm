import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/session";
import { getCommercialAccess } from "@/server/commercial/entitlement";

export const dynamic = "force-dynamic";

const STATUS_COPY = {
  trial: {
    title: "Tu periodo de prueba terminó",
    body: "Activa tu plan para seguir usando el CRM y conservar tu configuración.",
  },
  active: {
    title: "Tu cuenta está activa",
    body: "Puedes continuar usando el CRM.",
  },
  past_due: {
    title: "Tu cuenta requiere atención",
    body: "El periodo comercial está vencido. Regulariza el plan para reactivar el acceso.",
  },
  suspended: {
    title: "Tu cuenta está suspendida",
    body: "El acceso al CRM está suspendido hasta que se reactive el plan.",
  },
  cancelled: {
    title: "Tu plan está cancelado",
    body: "Tus datos se conservan, pero necesitas reactivar el servicio para volver a operar.",
  },
} as const;

export default async function AccessRequiredPage() {
  const session = await requireSession();
  const access = await getCommercialAccess(session.organizationId).catch(
    () => null
  );

  if (session.isSuperadmin || access?.allowed) redirect("/");

  const copy = access
    ? STATUS_COPY[access.status]
    : {
        title: "Tu cuenta no tiene un plan configurado",
        body: "Contacta al administrador para asignar un plan comercial antes de usar el CRM.",
      };

  const price = access
    ? new Intl.NumberFormat("es-MX", {
        style: "currency",
        currency: access.plan.currency,
        maximumFractionDigits: 0,
      }).format(access.plan.monthlyPriceCents / 100)
    : null;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <section className="w-full max-w-lg rounded-2xl border bg-background p-6 shadow-sm">
        <p className="kicker text-brand-text">Estado de la cuenta</p>
        <h1 className="mt-2 text-2xl font-bold">{copy.title}</h1>
        <p className="mt-3 text-sm leading-6 text-text-3">{copy.body}</p>

        {access && (
          <div className="mt-6 rounded-xl bg-secondary p-4 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span className="text-text-3">Plan</span>
              <strong>{access.plan.name}</strong>
            </div>
            <div className="mt-2 flex items-center justify-between gap-4">
              <span className="text-text-3">Precio</span>
              <strong>{price} / mes</strong>
            </div>
            <div className="mt-2 flex items-center justify-between gap-4">
              <span className="text-text-3">Estado</span>
              <strong className="capitalize">{access.status.replace("_", " ")}</strong>
            </div>
          </div>
        )}

        <p className="mt-6 text-xs leading-5 text-text-3">
          El bloqueo comercial no elimina prospectos, conversaciones, citas ni configuración.
        </p>
      </section>
    </main>
  );
}
