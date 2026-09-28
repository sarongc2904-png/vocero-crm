import Link from "next/link";
import {
  CalendarDays,
  Clock3,
  Inbox,
  Kanban,
  MessageCircleWarning,
} from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { getDashboardMetrics } from "@/server/dashboard/metrics";

export const dynamic = "force-dynamic";

function MetricCard({
  label,
  value,
  detail,
  href,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  detail?: string;
  href: string;
  icon: typeof Inbox;
}) {
  return (
    <Link
      href={href}
      className="rounded-xl border bg-background p-4 shadow-sm transition-colors hover:border-border-strong"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="kicker text-text-3">{label}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight">{value}</p>
          {detail && <p className="mt-1 text-xs text-text-3">{detail}</p>}
        </div>
        <span className="rounded-lg bg-brand-tint p-2 text-brand-text">
          <Icon className="h-4 w-4" strokeWidth={1.8} />
        </span>
      </div>
    </Link>
  );
}

export default async function DashboardPage() {
  const session = await requireSession();
  const data = await getDashboardMetrics(session.organizationId);

  return (
    <main className="h-full overflow-y-auto bg-subtle/40">
      <div className="mx-auto max-w-[1180px] px-4 py-5 md:px-6 md:py-7">
        {session.isSuperadmin && (
          <div className="mb-4 rounded-lg border border-warning-soft bg-warning-tint px-4 py-3 text-sm text-warning-text">
            <strong>Modo Superadmin.</strong> Estás administrando: {data.organization.name}
          </div>
        )}

        <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="kicker text-brand-text">{data.organization.name}</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">Resumen</h1>
            <p className="mt-1 text-sm text-text-3">
              Lo importante para atender clientes y mover oportunidades hoy.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/inbox"
              className="inline-flex h-9 items-center gap-2 rounded-md bg-brand px-3 text-xs font-semibold text-brand-fg"
            >
              <Inbox className="h-4 w-4" strokeWidth={1.8} />
              Abrir mensajes
            </Link>
            <Link
              href="/bookings"
              className="inline-flex h-9 items-center gap-2 rounded-md border border-border-strong bg-background px-3 text-xs font-semibold"
            >
              <CalendarDays className="h-4 w-4" strokeWidth={1.8} />
              Ver agenda
            </Link>
          </div>
        </div>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Requieren respuesta"
            value={data.conversations.unanswered30m}
            detail="Entradas sin respuesta por más de 30 min"
            href="/inbox"
            icon={MessageCircleWarning}
          />
          <MetricCard
            label="Citas de hoy"
            value={data.appointments.today}
            detail={`${data.appointments.upcoming} próximas agendadas`}
            href="/bookings"
            icon={CalendarDays}
          />
          <MetricCard
            label="Prospectos activos"
            value={data.pipeline.totalLeads}
            detail={`${data.pipeline.newLeads} nuevos en la primera etapa`}
            href="/pipeline"
            icon={Kanban}
          />
          <MetricCard
            label="Seguimientos vencidos"
            value={data.pipeline.overdueNextActions}
            detail="Acciones cuya fecha ya pasó"
            href="/pipeline"
            icon={Clock3}
          />
        </section>

        <section className="mt-6 grid gap-4 xl:grid-cols-[1.25fr_1fr]">
          <div className="rounded-xl border bg-background p-4 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="kicker">Prospectos por etapa</p>
                <p className="mt-1 text-xs text-text-3">
                  Una vista rápida de dónde está cada oportunidad.
                </p>
              </div>
              <Link href="/pipeline" className="text-xs font-semibold text-brand-text hover:underline">
                Ver prospectos →
              </Link>
            </div>

            <div className="space-y-3">
              {data.pipeline.stages.length === 0 ? (
                <p className="rounded-lg bg-subtle p-4 text-sm text-text-3">
                  Sin etapas configuradas.
                </p>
              ) : (
                data.pipeline.stages.map((stage) => {
                  const pct =
                    data.pipeline.totalLeads > 0
                      ? Math.round((stage.leads / data.pipeline.totalLeads) * 100)
                      : 0;
                  return (
                    <div key={stage.id}>
                      <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                        <span className="font-semibold">{stage.name}</span>
                        <span className="text-text-3">{stage.leads}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-secondary">
                        <div
                          className="h-full rounded-full bg-brand"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="rounded-xl border bg-background p-4 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="kicker">Próximas citas</p>
                <p className="mt-1 text-xs text-text-3">
                  Lo siguiente que necesita atención.
                </p>
              </div>
              <Link href="/bookings" className="text-xs font-semibold text-brand-text hover:underline">
                Abrir agenda →
              </Link>
            </div>

            {data.appointments.next.length === 0 ? (
              <p className="rounded-lg bg-subtle p-4 text-sm text-text-3">
                No hay próximas citas.
              </p>
            ) : (
              <div className="divide-y">
                {data.appointments.next.slice(0, 6).map((booking) => (
                  <div
                    key={booking.id}
                    className="flex items-center justify-between gap-4 py-3 first:pt-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{booking.contactName}</p>
                      <p className="text-xs text-text-3">{booking.date}</p>
                    </div>
                    <span className="font-mono text-sm font-semibold">{booking.time}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {(data.conversations.failedOutgoing > 0 ||
          data.conversations.humanHandoff > 0 ||
          data.pipeline.leadsWithoutNextAction > 0) && (
          <section className="mt-4 rounded-xl border bg-background p-4 shadow-sm">
            <p className="kicker mb-3">Necesita atención</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {data.conversations.failedOutgoing > 0 && (
                <Link href="/inbox" className="rounded-lg bg-danger-tint p-3">
                  <p className="text-sm font-semibold text-danger-text">Mensajes no enviados</p>
                  <p className="mt-1 text-2xl font-bold text-danger-text">
                    {data.conversations.failedOutgoing}
                  </p>
                </Link>
              )}
              {data.conversations.humanHandoff > 0 && (
                <Link href="/inbox" className="rounded-lg bg-warning-tint p-3">
                  <p className="text-sm font-semibold text-warning-text">Atención humana</p>
                  <p className="mt-1 text-2xl font-bold text-warning-text">
                    {data.conversations.humanHandoff}
                  </p>
                </Link>
              )}
              {data.pipeline.leadsWithoutNextAction > 0 && (
                <Link href="/pipeline" className="rounded-lg bg-subtle p-3">
                  <p className="text-sm font-semibold">Sin próxima acción</p>
                  <p className="mt-1 text-2xl font-bold">
                    {data.pipeline.leadsWithoutNextAction}
                  </p>
                </Link>
              )}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
