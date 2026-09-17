import Link from "next/link";
import {
  Bot,
  CalendarDays,
  CircleDollarSign,
  Inbox,
  Kanban,
  MessageSquareWarning,
  UserRoundCheck,
  Users,
} from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { formatMoneyCents } from "@/lib/money";
import { getBranding } from "@/server/branding";
import { getDashboardMetrics } from "@/server/dashboard/metrics";

export const dynamic = "force-dynamic";

type MetricCardProps = {
  label: string;
  value: string | number;
  detail?: string;
  href?: string;
  icon: typeof Inbox;
};

function MetricCard({ label, value, detail, href, icon: Icon }: MetricCardProps) {
  const content = (
    <div className="rounded-xl border bg-background p-4 shadow-sm transition-colors hover:border-border-strong">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-text-3">
            {label}
          </p>
          <p className="mt-2 text-2xl font-bold tracking-tight">{value}</p>
          {detail && <p className="mt-1 text-xs text-text-3">{detail}</p>}
        </div>
        <span className="rounded-lg bg-brand-tint p-2 text-brand-text">
          <Icon className="h-4 w-4" strokeWidth={1.8} />
        </span>
      </div>
    </div>
  );
  return href ? <Link href={href}>{content}</Link> : content;
}

export default async function DashboardPage() {
  const session = await requireSession();
  const [metrics, branding] = await Promise.all([
    getDashboardMetrics(session.organizationId),
    getBranding(session.organizationId),
  ]);

  const pipelineValue =
    formatMoneyCents(metrics.leads.pipelineAmountCents, branding.currency) ?? "—";

  return (
    <div className="h-full overflow-y-auto bg-subtle">
      <div className="mx-auto w-full max-w-7xl px-4 py-5 md:px-6 md:py-7">
        {session.isSuperadmin && (
          <div className="mb-5 rounded-lg border border-warning-soft bg-warning-tint px-4 py-3 text-sm text-warning-text">
            <strong>Modo Superadmin</strong> · Estás administrando: {metrics.organizationName}
          </div>
        )}

        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="kicker">Operación · {metrics.organizationName}</p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight md:text-3xl">
              Resumen operativo
            </h1>
            <p className="mt-1 text-sm text-text-3">
              Conversaciones, oportunidades, citas y carga del equipo en el tenant activo.
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/inbox"
              className="rounded-md border bg-background px-3 py-2 text-sm font-semibold hover:bg-accent"
            >
              Ir a Bandeja
            </Link>
            <Link
              href="/pipeline"
              className="rounded-md bg-brand px-3 py-2 text-sm font-semibold text-brand-fg hover:bg-brand-hover"
            >
              Abrir Pipeline
            </Link>
          </div>
        </div>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Conversaciones"
            value={metrics.conversations.total}
            detail={`${metrics.conversations.unread} mensajes no leídos`}
            href="/inbox"
            icon={Inbox}
          />
          <MetricCard
            label="Leads"
            value={metrics.leads.total}
            detail={`${metrics.leads.qualified} con ficha de calificación`}
            href="/pipeline"
            icon={Users}
          />
          <MetricCard
            label="Pipeline conocido"
            value={pipelineValue}
            detail={
              metrics.leads.pipelineAmountUnknown > 0
                ? `${metrics.leads.pipelineAmountUnknown} oportunidades sin monto`
                : `${metrics.leads.pipelineAmountKnown} oportunidades con monto`
            }
            href="/pipeline"
            icon={CircleDollarSign}
          />
          <MetricCard
            label="Citas de hoy"
            value={metrics.appointments.today}
            detail={`${metrics.appointments.upcoming} próximas agendadas`}
            href="/bookings"
            icon={CalendarDays}
          />
        </section>

        <section className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Atención humana"
            value={metrics.conversations.handoff}
            detail="Conversaciones con IA en pausa"
            href="/inbox"
            icon={MessageSquareWarning}
          />
          <MetricCard
            label="IA activa"
            value={metrics.conversations.aiActive}
            detail="Conversaciones habilitadas para responder"
            href="/inbox"
            icon={Bot}
          />
          <MetricCard
            label="Sin responsable"
            value={metrics.conversations.unassigned}
            detail="Conversaciones pendientes de asignación"
            href="/inbox"
            icon={UserRoundCheck}
          />
          <MetricCard
            label="Ganados / Perdidos"
            value={`${metrics.leads.won} / ${metrics.leads.lost}`}
            detail="Estado actual del pipeline"
            href="/pipeline"
            icon={Kanban}
          />
        </section>

        <div className="mt-6 grid gap-4 xl:grid-cols-[1.4fr_1fr]">
          <section className="rounded-xl border bg-background p-4 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="kicker">Pipeline</p>
                <h2 className="mt-1 text-lg font-bold">Oportunidades por etapa</h2>
              </div>
              <Link href="/pipeline" className="text-sm font-semibold text-brand-text hover:underline">
                Ver tablero
              </Link>
            </div>

            {metrics.stages.length === 0 ? (
              <p className="py-6 text-sm text-text-3">Todavía no hay etapas configuradas.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead className="text-left text-xs uppercase tracking-[0.06em] text-text-3">
                    <tr>
                      <th className="pb-2 font-semibold">Etapa</th>
                      <th className="pb-2 text-right font-semibold">Leads</th>
                      <th className="pb-2 text-right font-semibold">Valor conocido</th>
                      <th className="pb-2 text-right font-semibold">Sin monto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.stages.map((stage) => (
                      <tr key={`${stage.kind}:${stage.name}`} className="border-t">
                        <td className="py-3 font-medium">{stage.name}</td>
                        <td className="py-3 text-right tabular-nums">{stage.count}</td>
                        <td className="py-3 text-right tabular-nums">
                          {formatMoneyCents(stage.amountCents, branding.currency) ?? "—"}
                        </td>
                        <td className="py-3 text-right tabular-nums text-text-3">
                          {stage.amountUnknown}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-xl border bg-background p-4 shadow-sm">
            <div className="mb-4">
              <p className="kicker">Responsables</p>
              <h2 className="mt-1 text-lg font-bold">Carga de conversaciones</h2>
            </div>

            {metrics.workload.length === 0 ? (
              <div className="rounded-lg border border-dashed p-5 text-sm text-text-3">
                Aún no hay conversaciones asignadas a agentes o equipos.
              </div>
            ) : (
              <div className="space-y-2">
                {metrics.workload.map((item) => (
                  <div
                    key={`${item.kind}:${item.label}`}
                    className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{item.label}</p>
                      <p className="text-xs text-text-3">
                        {item.kind === "team" ? "Equipo" : "Agente"}
                      </p>
                    </div>
                    <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-bold tabular-nums">
                      {item.count}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
