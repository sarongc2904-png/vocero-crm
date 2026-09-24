import Link from "next/link";
import {
  Bot,
  CalendarDays,
  CircleDollarSign,
  Clock3,
  Inbox,
  Kanban,
  MessageCircleWarning,
  UsersRound,
} from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { getDashboardMetrics } from "@/server/dashboard/metrics";

export const dynamic = "force-dynamic";

function money(cents: number | null, currency: string) {
  if (cents === null) return "Sin monto capturado";
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function percent(value: number | null) {
  return value === null ? "Sin datos" : `${Math.round(value * 100)}%`;
}

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
  href?: string;
  icon: typeof Inbox;
}) {
  const content = (
    <div className="rounded-xl border bg-background p-4 shadow-sm transition-colors hover:border-border-strong">
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
    </div>
  );
  return href ? <Link href={href}>{content}</Link> : content;
}

export default async function DashboardPage() {
  const session = await requireSession();
  const data = await getDashboardMetrics(session.organizationId);

  return (
    <main className="h-full overflow-y-auto bg-subtle/40">
      <div className="mx-auto max-w-[1480px] px-4 py-5 md:px-6 md:py-7">
        {session.isSuperadmin && (
          <div className="mb-4 rounded-lg border border-warning-soft bg-warning-tint px-4 py-3 text-sm text-warning-text">
            <strong>Modo Superadmin.</strong> Estás administrando: {data.organization.name}
          </div>
        )}

        <div className="mb-6 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="kicker text-brand-text">Operación · {data.organization.name}</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">Dashboard</h1>
            <p className="mt-1 text-sm text-text-3">
              Conversaciones, pipeline, citas y carga operativa del tenant activo.
            </p>
          </div>
          <p className="text-xs text-text-3">
            Actualizado {new Date(data.generatedAt).toLocaleString("es-MX")}
          </p>
        </div>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Conversaciones activas"
            value={data.conversations.active24h}
            detail="Con mensaje entrante en las últimas 24 h"
            href="/inbox"
            icon={Inbox}
          />
          <MetricCard
            label="No leídas"
            value={data.conversations.unreadConversations}
            detail={`${data.conversations.unreadMessages} mensajes pendientes`}
            href="/inbox"
            icon={MessageCircleWarning}
          />
          <MetricCard
            label="Sin respuesta >30 min"
            value={data.conversations.unanswered30m}
            detail="Conversaciones con entrada pendiente de respuesta"
            href="/inbox"
            icon={MessageCircleWarning}
          />
          <MetricCard
            label="Mensajes no enviados"
            value={data.conversations.failedOutgoing}
            detail="Últimos intentos de salida que fallaron y requieren revisión"
            href="/inbox"
            icon={MessageCircleWarning}
          />
          <MetricCard
            label="Leads en pipeline"
            value={data.pipeline.totalLeads}
            detail={`${data.pipeline.newLeads} en la primera etapa abierta`}
            href="/pipeline"
            icon={Kanban}
          />
          <MetricCard
            label="Valor del pipeline"
            value={money(data.pipeline.pipelineValueCents, data.currency)}
            detail={
              data.pipeline.pipelineValueCents === null
                ? "No se convierte ausencia de monto en $0"
                : `${data.pipeline.knownAmounts} oportunidades con monto conocido`
            }
            href="/pipeline"
            icon={CircleDollarSign}
          />
          <MetricCard
            label="Citas de hoy"
            value={data.appointments.today}
            detail={`${data.appointments.upcoming} próximas agendadas`}
            href="/bookings"
            icon={CalendarDays}
          />
          <MetricCard
            label="Atención humana"
            value={data.conversations.humanHandoff}
            detail="Conversaciones con IA en handoff"
            href="/inbox"
            icon={UsersRound}
          />
          <MetricCard
            label="Sin responsable"
            value={data.workload.unassigned}
            detail="Conversaciones todavía sin agente/equipo"
            href="/inbox"
            icon={Clock3}
          />
          <MetricCard
            label="Sin próxima acción"
            value={data.pipeline.leadsWithoutNextAction}
            detail="Leads abiertos sin seguimiento programado"
            href="/pipeline"
            icon={Clock3}
          />
          <MetricCard
            label="Seguimientos vencidos"
            value={data.pipeline.overdueNextActions}
            detail="Próximas acciones cuya fecha ya pasó"
            href="/pipeline"
            icon={MessageCircleWarning}
          />
          <MetricCard
            label="Agente IA"
            value={data.ai.enabled && data.ai.configured ? "Activo" : "Revisar"}
            detail={
              !data.ai.configured
                ? "Proveedor de IA no configurado"
                : data.ai.enabled
                  ? data.ai.name ?? "Agente habilitado"
                  : "Perfil configurado pero apagado"
            }
            href="/agent"
            icon={Bot}
          />
        </section>

        <section className="mt-6 grid gap-4 xl:grid-cols-[1.35fr_1fr]">
          <div className="rounded-xl border bg-background p-4 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="kicker">Pipeline por etapa</p>
                <p className="mt-1 text-xs text-text-3">Sólo datos del tenant activo.</p>
              </div>
              <Link href="/pipeline" className="text-xs font-semibold text-brand-text hover:underline">
                Abrir pipeline →
              </Link>
            </div>
            <div className="space-y-3">
              {data.pipeline.stages.length === 0 ? (
                <p className="rounded-lg bg-subtle p-4 text-sm text-text-3">Sin etapas configuradas.</p>
              ) : (
                data.pipeline.stages.map((stage) => {
                  const pct = data.pipeline.totalLeads > 0
                    ? Math.round((stage.leads / data.pipeline.totalLeads) * 100)
                    : 0;
                  return (
                    <div key={stage.id}>
                      <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                        <span className="font-semibold">{stage.name}</span>
                        <span className="text-text-3">{stage.leads} · {pct}%</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-secondary">
                        <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 border-t pt-4 sm:grid-cols-4">
              <div>
                <p className="kicker">Ganados</p>
                <p className="mt-1 text-2xl font-bold">{data.pipeline.wonLeads}</p>
              </div>
              <div>
                <p className="kicker">Perdidos</p>
                <p className="mt-1 text-2xl font-bold">{data.pipeline.lostLeads}</p>
              </div>
              <div>
                <p className="kicker">Conversión actual</p>
                <p className="mt-1 text-2xl font-bold">{percent(data.pipeline.currentWinRate)}</p>
              </div>
              <div>
                <p className="kicker">Con cita</p>
                <p className="mt-1 text-2xl font-bold">{percent(data.pipeline.appointmentCoverage)}</p>
              </div>
            </div>
          </div>

          <div className="rounded-xl border bg-background p-4 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="kicker">Próximas citas</p>
                <p className="mt-1 text-xs text-text-3">Sesiones agendadas, sin datos de prueba.</p>
              </div>
              <Link href="/bookings" className="text-xs font-semibold text-brand-text hover:underline">
                Abrir agenda →
              </Link>
            </div>
            {data.appointments.next.length === 0 ? (
              <p className="rounded-lg bg-subtle p-4 text-sm text-text-3">No hay próximas citas.</p>
            ) : (
              <div className="divide-y">
                {data.appointments.next.map((booking) => (
                  <div key={booking.id} className="flex items-center justify-between gap-4 py-3 first:pt-0">
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

        <section className="mt-4 grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border bg-background p-4 shadow-sm">
            <p className="kicker">Valor ganado actual</p>
            <p className="mt-2 text-2xl font-bold">{money(data.pipeline.wonValueCents, data.currency)}</p>
            <p className="mt-1 text-xs text-text-3">
              {data.pipeline.wonKnownAmounts} oportunidades ganadas con monto conocido.
            </p>
          </div>
          <div className="rounded-xl border bg-background p-4 shadow-sm">
            <p className="kicker">Valor perdido actual</p>
            <p className="mt-2 text-2xl font-bold">{money(data.pipeline.lostValueCents, data.currency)}</p>
            <p className="mt-1 text-xs text-text-3">
              {data.pipeline.lostKnownAmounts} oportunidades perdidas con monto conocido.
            </p>
          </div>
          <div className="rounded-xl border bg-background p-4 shadow-sm">
            <p className="kicker mb-3">Fuente de prospectos</p>
            {data.sources.length === 0 ? (
              <p className="text-sm text-text-3">Sin fuentes registradas.</p>
            ) : (
              <div className="space-y-2">
                {data.sources.slice(0, 6).map((item) => (
                  <div key={item.source} className="flex items-center justify-between gap-3 text-sm">
                    <span className="capitalize">{item.source.replaceAll("_", " ")}</span>
                    <span className="font-semibold">{item.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="mt-4 grid gap-4 xl:grid-cols-3">
          <div className="rounded-xl border bg-background p-4 shadow-sm">
            <p className="kicker mb-3">Carga por agente</p>
            {data.workload.agents.length === 0 ? (
              <p className="text-sm text-text-3">Sin conversaciones asignadas a agentes.</p>
            ) : (
              <div className="space-y-2">
                {data.workload.agents.slice(0, 8).map((agent) => (
                  <div key={agent.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate">{agent.name}</span>
                    <span className="font-semibold">{agent.conversations}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border bg-background p-4 shadow-sm">
            <p className="kicker mb-3">Carga por equipo</p>
            {data.workload.teams.length === 0 ? (
              <p className="text-sm text-text-3">Sin conversaciones asignadas a equipos.</p>
            ) : (
              <div className="space-y-2">
                {data.workload.teams.slice(0, 8).map((team) => (
                  <div key={team.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate">{team.name}</span>
                    <span className="font-semibold">{team.conversations}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border bg-background p-4 shadow-sm">
            <p className="kicker mb-3">Motivos de pérdida</p>
            {data.lossReasons.length === 0 ? (
              <p className="text-sm text-text-3">Todavía no hay motivos de pérdida registrados.</p>
            ) : (
              <div className="space-y-2">
                {data.lossReasons.slice(0, 8).map((item) => (
                  <div key={item.reason} className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate">{item.reason.replaceAll("_", " ")}</span>
                    <span className="font-semibold">{item.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="mt-4 grid gap-4 xl:grid-cols-[1.4fr_1fr]">
          <div className="rounded-xl border bg-background p-4 shadow-sm">
            <p className="kicker mb-3">Actividad reciente</p>
            {data.recentActivity.length === 0 ? (
              <p className="text-sm text-text-3">Sin movimientos de pipeline registrados.</p>
            ) : (
              <div className="divide-y">
                {data.recentActivity.map((event) => (
                  <div key={event.id} className="py-3 first:pt-0">
                    <p className="text-sm">
                      <strong>{event.contactName}</strong>{" "}
                      {event.fromStageName ? `${event.fromStageName} → ` : "entró a "}
                      <strong>{event.toStageName}</strong>
                    </p>
                    <p className="mt-0.5 text-xs text-text-3">
                      {new Date(event.occurredAt).toLocaleString("es-MX")} · {event.source}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border bg-background p-4 shadow-sm">
            <p className="kicker mb-3">Seguimiento comercial</p>
            <div className="space-y-3 text-sm">
              <div className="rounded-lg bg-subtle p-3">
                <p className="font-semibold">Sin próxima acción</p>
                <p className="mt-1 text-2xl font-bold">{data.pipeline.leadsWithoutNextAction}</p>
                <p className="mt-1 text-xs text-text-3">
                  Leads abiertos que todavía no tienen una acción y fecha programadas.
                </p>
              </div>
              <div className="rounded-lg bg-subtle p-3">
                <p className="font-semibold">Seguimientos vencidos</p>
                <p className="mt-1 text-2xl font-bold">{data.pipeline.overdueNextActions}</p>
                <p className="mt-1 text-xs text-text-3">
                  Acciones programadas cuya fecha ya pasó y requieren atención.
                </p>
              </div>
              <div className="rounded-lg bg-subtle p-3">
                <p className="font-semibold">Leads calificados</p>
                <p className="mt-1 text-xs text-text-3">
                  No disponible aún. {data.unavailable.qualifiedLeads}.
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
