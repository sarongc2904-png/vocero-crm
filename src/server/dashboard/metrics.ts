import { getSql } from "@/lib/db";

export type DashboardStageMetric = {
  name: string;
  kind: "open" | "won" | "lost";
  count: number;
  amountCents: number;
  amountKnown: number;
  amountUnknown: number;
};

export type DashboardWorkload = {
  label: string;
  kind: "agent" | "team";
  count: number;
};

export type DashboardMetrics = {
  organizationName: string;
  conversations: {
    total: number;
    unread: number;
    handoff: number;
    aiActive: number;
    unassigned: number;
  };
  leads: {
    total: number;
    qualified: number;
    won: number;
    lost: number;
    pipelineAmountCents: number;
    pipelineAmountKnown: number;
    pipelineAmountUnknown: number;
  };
  appointments: {
    today: number;
    upcoming: number;
  };
  stages: DashboardStageMetric[];
  workload: DashboardWorkload[];
};

export async function getDashboardMetrics(
  organizationId: string
): Promise<DashboardMetrics> {
  const sql = getSql();

  const [orgRows, conversationRows, leadRows, appointmentRows, stageRows, workloadRows] =
    await Promise.all([
      sql<{ name: string }[]>`
        select name
        from organization
        where id = ${organizationId}
        limit 1
      `,
      sql<{
        total: number;
        unread: number;
        handoff: number;
        ai_active: number;
        unassigned: number;
      }[]>`
        select
          count(*)::int as total,
          coalesce(sum(c.unread_count), 0)::int as unread,
          count(*) filter (where c.handoff_at is not null)::int as handoff,
          count(*) filter (where c.ai_enabled = true and c.handoff_at is null)::int as ai_active,
          count(*) filter (where ca.conversation_id is null)::int as unassigned
        from conversation c
        left join conversation_assignment ca
          on ca.conversation_id = c.id
         and ca.organization_id = c.organization_id
        where c.organization_id = ${organizationId}
          and c.is_test = false
      `,
      sql<{
        total: number;
        qualified: number;
        won: number;
        lost: number;
        pipeline_amount_cents: number;
        pipeline_amount_known: number;
        pipeline_amount_unknown: number;
      }[]>`
        select
          count(*)::int as total,
          count(*) filter (
            where c.ficha is not null and c.ficha <> '{}'::jsonb
          )::int as qualified,
          count(*) filter (where ps.kind = 'won')::int as won,
          count(*) filter (where ps.kind = 'lost')::int as lost,
          coalesce(sum(l.amount_cents) filter (where ps.kind = 'open'), 0)::bigint as pipeline_amount_cents,
          count(*) filter (where ps.kind = 'open' and l.amount_cents is not null)::int as pipeline_amount_known,
          count(*) filter (where ps.kind = 'open' and l.amount_cents is null)::int as pipeline_amount_unknown
        from lead l
        join contact c
          on c.id = l.contact_id
         and c.organization_id = l.organization_id
        join pipeline_stage ps
          on ps.id = l.stage_id
         and ps.organization_id = l.organization_id
        where l.organization_id = ${organizationId}
      `,
      sql<{
        today: number;
        upcoming: number;
      }[]>`
        select
          count(*) filter (
            where b.kind = 'session'
              and b.status = 'agendada'
              and b.scheduled_at::date = current_date
          )::int as today,
          count(*) filter (
            where b.kind = 'session'
              and b.status = 'agendada'
              and b.scheduled_at > now()
          )::int as upcoming
        from booking b
        where b.organization_id = ${organizationId}
          and b.is_test = false
      `,
      sql<{
        name: string;
        kind: "open" | "won" | "lost";
        count: number;
        amount_cents: number;
        amount_known: number;
        amount_unknown: number;
      }[]>`
        select
          ps.name,
          ps.kind,
          count(l.id)::int as count,
          coalesce(sum(l.amount_cents), 0)::bigint as amount_cents,
          count(l.id) filter (where l.amount_cents is not null)::int as amount_known,
          count(l.id) filter (where l.amount_cents is null)::int as amount_unknown
        from pipeline_stage ps
        left join lead l
          on l.stage_id = ps.id
         and l.organization_id = ps.organization_id
        where ps.organization_id = ${organizationId}
        group by ps.id, ps.name, ps.kind, ps.position
        order by ps.position
      `,
      sql<{
        label: string;
        kind: "agent" | "team";
        count: number;
      }[]>`
        select label, kind, count(*)::int as count
        from (
          select
            coalesce(u.name, u.email, 'Agente') as label,
            'agent'::text as kind
          from conversation_assignment ca
          join member m
            on m.id = ca.member_id
           and m.organization_id = ca.organization_id
          join "user" u on u.id = m.user_id
          where ca.organization_id = ${organizationId}
            and ca.member_id is not null

          union all

          select
            t.name as label,
            'team'::text as kind
          from conversation_assignment ca
          join team t
            on t.id = ca.team_id
           and t.organization_id = ca.organization_id
          where ca.organization_id = ${organizationId}
            and ca.team_id is not null
        ) workload
        group by label, kind
        order by count desc, lower(label)
      `,
    ]);

  const conversations = conversationRows[0] ?? {
    total: 0,
    unread: 0,
    handoff: 0,
    ai_active: 0,
    unassigned: 0,
  };
  const leads = leadRows[0] ?? {
    total: 0,
    qualified: 0,
    won: 0,
    lost: 0,
    pipeline_amount_cents: 0,
    pipeline_amount_known: 0,
    pipeline_amount_unknown: 0,
  };
  const appointments = appointmentRows[0] ?? { today: 0, upcoming: 0 };

  return {
    organizationName: orgRows[0]?.name ?? "Organización",
    conversations: {
      total: Number(conversations.total),
      unread: Number(conversations.unread),
      handoff: Number(conversations.handoff),
      aiActive: Number(conversations.ai_active),
      unassigned: Number(conversations.unassigned),
    },
    leads: {
      total: Number(leads.total),
      qualified: Number(leads.qualified),
      won: Number(leads.won),
      lost: Number(leads.lost),
      pipelineAmountCents: Number(leads.pipeline_amount_cents),
      pipelineAmountKnown: Number(leads.pipeline_amount_known),
      pipelineAmountUnknown: Number(leads.pipeline_amount_unknown),
    },
    appointments: {
      today: Number(appointments.today),
      upcoming: Number(appointments.upcoming),
    },
    stages: stageRows.map((row) => ({
      name: row.name,
      kind: row.kind,
      count: Number(row.count),
      amountCents: Number(row.amount_cents),
      amountKnown: Number(row.amount_known),
      amountUnknown: Number(row.amount_unknown),
    })),
    workload: workloadRows.map((row) => ({
      label: row.label,
      kind: row.kind,
      count: Number(row.count),
    })),
  };
}
