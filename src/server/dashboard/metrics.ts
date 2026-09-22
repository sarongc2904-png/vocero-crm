import { getSql } from "@/lib/db";
import { isAiConfigured } from "@/lib/env";
import { partsInTz } from "@/lib/time/slots";
import { getSettings } from "@/server/agenda/settings";
import { listBookings } from "@/server/agenda/queries";
import { getBranding } from "@/server/branding";

function n(value: string | number | bigint | null | undefined): number {
  if (value == null) return 0;
  return Number(value);
}

export type DashboardStageMetric = {
  id: string;
  name: string;
  kind: "open" | "won" | "lost";
  position: number;
  leads: number;
  amountCents: number;
  knownAmounts: number;
};

function amountSummary(stages: DashboardStageMetric[], kind: DashboardStageMetric["kind"]) {
  const subset = stages.filter((stage) => stage.kind === kind);
  const knownAmounts = subset.reduce((sum, stage) => sum + stage.knownAmounts, 0);
  return {
    knownAmounts,
    valueCents:
      knownAmounts === 0
        ? null
        : subset.reduce((sum, stage) => sum + stage.amountCents, 0),
  };
}

export function summarizeStages(stages: DashboardStageMetric[]) {
  const firstOpen = stages.find((stage) => stage.kind === "open") ?? null;
  const openAmounts = amountSummary(stages, "open");
  const wonAmounts = amountSummary(stages, "won");
  const lostAmounts = amountSummary(stages, "lost");
  const totalLeads = stages.reduce((sum, stage) => sum + stage.leads, 0);
  const wonLeads = stages
    .filter((stage) => stage.kind === "won")
    .reduce((sum, stage) => sum + stage.leads, 0);
  const lostLeads = stages
    .filter((stage) => stage.kind === "lost")
    .reduce((sum, stage) => sum + stage.leads, 0);

  return {
    totalLeads,
    newLeads: firstOpen?.leads ?? 0,
    wonLeads,
    lostLeads,
    pipelineValueCents: openAmounts.valueCents,
    knownAmounts: openAmounts.knownAmounts,
    wonValueCents: wonAmounts.valueCents,
    wonKnownAmounts: wonAmounts.knownAmounts,
    lostValueCents: lostAmounts.valueCents,
    lostKnownAmounts: lostAmounts.knownAmounts,
    currentWinRate: totalLeads === 0 ? null : wonLeads / totalLeads,
  };
}

export async function getDashboardMetrics(organizationId: string) {
  const sql = getSql();
  const now = new Date();

  const [
    organizationRows,
    conversationRows,
    stageRows,
    assignmentRows,
    unassignedRows,
    agentRows,
    activityRows,
    lossReasonRows,
    sourceRows,
    appointmentCoverageRows,
    nextActionRows,
  ] = await Promise.all([
    sql<{ name: string }[]>`
      select name
      from organization
      where id = ${organizationId}
      limit 1
    `,
    sql<{
      total: string | number;
      active_24h: string | number;
      unread_conversations: string | number;
      unread_messages: string | number;
      handoff: string | number;
      unanswered_30m: string | number;
      failed_outgoing: string | number;
    }[]>`
      select
        count(*) filter (where is_test = false) as total,
        count(*) filter (
          where is_test = false
            and last_inbound_at is not null
            and last_inbound_at >= now() - interval '24 hours'
        ) as active_24h,
        count(*) filter (where is_test = false and unread_count > 0) as unread_conversations,
        coalesce(sum(unread_count) filter (where is_test = false), 0) as unread_messages,
        count(*) filter (where is_test = false and handoff_at is not null) as handoff,
        count(*) filter (
          where is_test = false
            and last_inbound_at is not null
            and last_inbound_at <= now() - interval '30 minutes'
            and not exists (
              select 1
              from message m
              where m.organization_id = conversation.organization_id
                and m.conversation_id = conversation.id
                and m.direction = 'out'
                and coalesce(m.wa_timestamp, m.created_at) > conversation.last_inbound_at
            )
        ) as unanswered_30m,
        count(*) filter (
          where is_test = false
            and exists (
              select 1
              from message failed
              where failed.organization_id = conversation.organization_id
                and failed.conversation_id = conversation.id
                and failed.direction = 'out'
                and failed.status = 'failed'
                and not exists (
                  select 1
                  from message later
                  where later.organization_id = failed.organization_id
                    and later.conversation_id = failed.conversation_id
                    and later.direction = 'out'
                    and later.created_at > failed.created_at
                )
            )
        ) as failed_outgoing
      from conversation
      where organization_id = ${organizationId}
    `,
    sql<{
      id: string;
      name: string;
      kind: "open" | "won" | "lost";
      position: number;
      leads: string | number;
      amount_cents: string | number;
      known_amounts: string | number;
    }[]>`
      select
        s.id,
        s.name,
        s.kind,
        s.position,
        count(l.id) as leads,
        coalesce(sum(l.amount_cents) filter (where l.amount_cents is not null), 0) as amount_cents,
        count(l.amount_cents) as known_amounts
      from pipeline_stage s
      left join lead l
        on l.stage_id = s.id
       and l.organization_id = s.organization_id
      where s.organization_id = ${organizationId}
      group by s.id, s.name, s.kind, s.position
      order by s.position asc
    `,
    sql<{
      kind: "member" | "team";
      id: string;
      label: string;
      assignments: string | number;
    }[]>`
      select 'member'::text as kind, m.user_id as id, u.name as label, count(*) as assignments
      from conversation_assignment ca
      join member m
        on m.id = ca.member_id
       and m.organization_id = ca.organization_id
      join "user" u on u.id = m.user_id
      where ca.organization_id = ${organizationId}
        and ca.member_id is not null
      group by m.user_id, u.name
      union all
      select 'team'::text as kind, t.id as id, t.name as label, count(*) as assignments
      from conversation_assignment ca
      join team t
        on t.id = ca.team_id
       and t.organization_id = ca.organization_id
      where ca.organization_id = ${organizationId}
        and ca.team_id is not null
      group by t.id, t.name
    `,
    sql<{ count: string | number }[]>`
      select count(*) as count
      from conversation c
      left join conversation_assignment ca
        on ca.conversation_id = c.id
       and ca.organization_id = c.organization_id
      where c.organization_id = ${organizationId}
        and c.is_test = false
        and ca.conversation_id is null
    `,
    sql<{ enabled: boolean; name: string }[]>`
      select enabled, name
      from agent_profile
      where organization_id = ${organizationId}
      limit 1
    `,
    sql<{
      id: string;
      occurred_at: Date;
      contact_name: string;
      from_stage_name: string | null;
      to_stage_name: string;
      source: string;
    }[]>`
      select
        e.id,
        e.occurred_at,
        c.name as contact_name,
        e.from_stage_name,
        e.to_stage_name,
        e.source
      from lead_stage_event e
      join contact c
        on c.id = e.contact_id
       and c.organization_id = e.organization_id
      where e.organization_id = ${organizationId}
      order by e.occurred_at desc
      limit 8
    `,
    sql<{ reason: string; count: string | number }[]>`
      select loss_reason as reason, count(*) as count
      from lead_stage_event
      where organization_id = ${organizationId}
        and to_stage_kind = 'lost'
        and loss_reason is not null
      group by loss_reason
      order by count(*) desc, loss_reason asc
    `,
    sql<{ source: string; count: string | number }[]>`
      select coalesce(c.source, 'desconocida') as source, count(*) as count
      from lead l
      join contact c
        on c.id = l.contact_id
       and c.organization_id = l.organization_id
      where l.organization_id = ${organizationId}
      group by coalesce(c.source, 'desconocida')
      order by count(*) desc, source asc
    `,
    sql<{ leads_with_appointment: string | number }[]>`
      select count(distinct l.id) as leads_with_appointment
      from lead l
      join booking b
        on b.contact_id = l.contact_id
       and b.organization_id = l.organization_id
       and b.kind = 'session'
       and b.status <> 'cancelada'
       and b.is_test = false
      where l.organization_id = ${organizationId}
    `,
    sql<{
      without_next_action: string | number;
      overdue_next_action: string | number;
    }[]>`
      select
        count(*) filter (
          where s.kind = 'open'
            and (l.next_action_type is null or l.next_action_at is null)
        ) as without_next_action,
        count(*) filter (
          where s.kind = 'open'
            and l.next_action_type is not null
            and l.next_action_at is not null
            and l.next_action_at < now()
        ) as overdue_next_action
      from lead l
      join pipeline_stage s
        on s.id = l.stage_id
       and s.organization_id = l.organization_id
      where l.organization_id = ${organizationId}
    `,
  ]);

  const branding = await getBranding(organizationId);
  const settings = await getSettings(organizationId);
  const bookings = await listBookings(organizationId);
  const today = partsInTz(now.toISOString(), settings.timezone).date;
  const futureSessions = bookings
    .filter(
      (booking) =>
        booking.kind === "session" &&
        booking.status === "agendada" &&
        !booking.isTest &&
        Date.parse(booking.scheduledAtUtc) >= now.getTime()
    )
    .sort(
      (a, b) => Date.parse(a.scheduledAtUtc) - Date.parse(b.scheduledAtUtc)
    );

  const stages: DashboardStageMetric[] = stageRows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    position: row.position,
    leads: n(row.leads),
    amountCents: n(row.amount_cents),
    knownAmounts: n(row.known_amounts),
  }));
  const pipeline = summarizeStages(stages);
  const conversations = conversationRows[0];
  const agent = agentRows[0] ?? null;
  const leadsWithAppointment = n(appointmentCoverageRows[0]?.leads_with_appointment);
  const nextAction = nextActionRows[0];

  return {
    organization: {
      id: organizationId,
      name: organizationRows[0]?.name ?? "Organización",
    },
    generatedAt: now.toISOString(),
    currency: branding.currency,
    conversations: {
      total: n(conversations?.total),
      active24h: n(conversations?.active_24h),
      unreadConversations: n(conversations?.unread_conversations),
      unreadMessages: n(conversations?.unread_messages),
      humanHandoff: n(conversations?.handoff),
      unanswered30m: n(conversations?.unanswered_30m),
      failedOutgoing: n(conversations?.failed_outgoing),
    },
    pipeline: {
      ...pipeline,
      stages,
      leadsWithAppointment,
      appointmentCoverage:
        pipeline.totalLeads === 0 ? null : leadsWithAppointment / pipeline.totalLeads,
      qualifiedLeads: null as number | null,
      leadsWithoutNextAction: n(nextAction?.without_next_action),
      overdueNextActions: n(nextAction?.overdue_next_action),
    },
    appointments: {
      today: futureSessions.filter((booking) => booking.date === today).length,
      upcoming: futureSessions.length,
      next: futureSessions.slice(0, 5).map((booking) => ({
        id: booking.id,
        scheduledAtUtc: booking.scheduledAtUtc,
        date: booking.date,
        time: booking.time,
        contactName: booking.contact?.name ?? "Sin contacto",
      })),
    },
    workload: {
      unassigned: n(unassignedRows[0]?.count),
      agents: assignmentRows
        .filter((row) => row.kind === "member")
        .map((row) => ({ id: row.id, name: row.label, conversations: n(row.assignments) }))
        .sort((a, b) => b.conversations - a.conversations),
      teams: assignmentRows
        .filter((row) => row.kind === "team")
        .map((row) => ({ id: row.id, name: row.label, conversations: n(row.assignments) }))
        .sort((a, b) => b.conversations - a.conversations),
    },
    ai: {
      configured: isAiConfigured(),
      enabled: Boolean(agent?.enabled),
      name: agent?.name ?? null,
    },
    sources: sourceRows.map((row) => ({
      source: row.source,
      count: n(row.count),
    })),
    lossReasons: lossReasonRows.map((row) => ({
      reason: row.reason,
      count: n(row.count),
    })),
    recentActivity: activityRows.map((row) => ({
      id: row.id,
      contactName: row.contact_name,
      fromStageName: row.from_stage_name,
      toStageName: row.to_stage_name,
      source: row.source,
      occurredAt: new Date(row.occurred_at).toISOString(),
    })),
    unavailable: {
      qualifiedLeads: "Requiere el contrato formal de calificación del gate de Pipeline",
      nextAction: null,
    },
  };
}
