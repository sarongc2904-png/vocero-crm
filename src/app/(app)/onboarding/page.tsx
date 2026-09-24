import Link from "next/link";
import { requireSession } from "@/lib/auth/session";
import { getCommercialAccess } from "@/server/commercial/entitlement";
import { getOnboardingState } from "@/server/commercial/onboarding";
import { OnboardingActivateButton } from "@/components/onboarding-activate-button";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const session = await requireSession();
  const [onboarding, subscription] = await Promise.all([
    getOnboardingState(session.organizationId),
    getCommercialAccess(session.organizationId),
  ]);
  return (
    <main className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-2xl space-y-5">
        <div>
          <p className="kicker text-brand-text">Activación guiada</p>
          <h1 className="mt-1 text-2xl font-bold">Configura tu CRM</h1>
          <p className="mt-1 text-sm text-text-3">
            Vamos paso a paso. Completa lo esencial y deja lo opcional para después.
          </p>
          <p className="mt-1 text-xs text-text-3">
            {onboarding.completed} de {onboarding.total} pasos completos · Plan {subscription.plan.name} por {new Intl.NumberFormat("es-MX", { style: "currency", currency: subscription.plan.currency, maximumFractionDigits: 0 }).format(subscription.plan.monthlyPriceCents / 100)} al mes.
          </p>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-secondary">
          <div className="h-full bg-brand" style={{ width: `${Math.round((onboarding.completed / onboarding.total) * 100)}%` }} />
        </div>

        {onboarding.nextStep ? (
          <section className="rounded-xl border border-brand bg-brand-tint p-4">
            <p className="kicker text-brand-text">Siguiente paso</p>
            <h2 className="mt-1 text-lg font-bold">{onboarding.nextStep.label}</h2>
            <p className="mt-1 text-sm text-text-2">
              Solo necesitas terminar este paso para seguir avanzando.
            </p>
            <Link
              href={onboarding.nextStep.href}
              className="mt-3 inline-flex items-center justify-center rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-fg"
            >
              Continuar configuración
            </Link>
          </section>
        ) : onboarding.readyToActivate &&
          !onboarding.steps.find((step) => step.id === "activation")?.complete ? (
          <section className="rounded-xl border border-success-soft bg-success-tint p-4">
            <p className="kicker text-success-text">Todo listo</p>
            <h2 className="mt-1 text-lg font-bold">Tu CRM está preparado</h2>
            <p className="mt-1 text-sm text-text-2">
              Actívalo y entra directamente a tus mensajes.
            </p>
            <div className="mt-3">
              <OnboardingActivateButton enabled />
            </div>
          </section>
        ) : (
          <section className="rounded-xl border bg-background p-4">
            <p className="kicker text-brand-text">CRM activo</p>
            <h2 className="mt-1 text-lg font-bold">Ya puedes operar</h2>
            <Link
              href="/inbox"
              className="mt-3 inline-flex items-center justify-center rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-fg"
            >
              Ir a mensajes
            </Link>
          </section>
        )}

        <ol className="divide-y rounded-xl border bg-background">
          {onboarding.steps.map((step, index) => (
            <li key={step.id} className="flex items-center gap-3 p-4">
              <span className={`flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold ${step.complete ? "bg-brand text-brand-fg" : "bg-secondary text-text-2"}`}>
                {step.complete ? "✓" : index + 1}
              </span>
              <span className="flex-1 text-sm font-semibold">
                {step.label}{step.optional ? " (opcional)" : ""}
              </span>
              <Link className="text-sm font-semibold text-brand-text hover:underline" href={step.href}>
                {step.complete ? "Revisar" : step.optional ? "Opcional" : "Continuar"}
              </Link>
            </li>
          ))}
        </ol>
        {!onboarding.readyToActivate && (
          <p className="text-sm text-text-3">
            Solo necesitas completar los pasos esenciales. Horario y Google Calendar pueden configurarse después.
          </p>
        )}

      </div>
    </main>
  );
}
