import { getSql } from "@/lib/db";

export type ConversationAssignment =
  | { kind: "member"; id: string; name: string }
  | { kind: "team"; id: string; name: string }
  | null;

export async function getConversationAssignment(
  organizationId: string,
  conversationId: string
): Promise<ConversationAssignment> {
  const sql = getSql();
  const rows = await sql<{
    member_id: string | null;
    member_name: string | null;
    team_id: string | null;
    team_name: string | null;
  }[]>`
    select
      ca.member_id,
      u.name as member_name,
      ca.team_id,
      t.name as team_name
    from conversation_assignment ca
    join conversation c
      on c.id = ca.conversation_id
     and c.organization_id = ca.organization_id
    left join member m
      on m.id = ca.member_id
     and m.organization_id = ca.organization_id
    left join "user" u on u.id = m.user_id
    left join team t
      on t.id = ca.team_id
     and t.organization_id = ca.organization_id
    where ca.organization_id = ${organizationId}
      and ca.conversation_id = ${conversationId}
    limit 1
  `;

  const row = rows[0];
  if (!row) return null;
  if (row.member_id) {
    return { kind: "member", id: row.member_id, name: row.member_name ?? "Agente" };
  }
  if (row.team_id) {
    return { kind: "team", id: row.team_id, name: row.team_name ?? "Equipo" };
  }
  return null;
}

export async function setConversationAssignment(input: {
  organizationId: string;
  conversationId: string;
  actorUserId: string;
  target: { kind: "member" | "team"; id: string } | null;
}): Promise<boolean> {
  const sql = getSql();

  if (!input.target) {
    const deleted = await sql<{ conversation_id: string }[]>`
      delete from conversation_assignment
      where organization_id = ${input.organizationId}
        and conversation_id = ${input.conversationId}
      returning conversation_id
    `;
    if (deleted.length > 0) return true;

    const conversation = await sql<{ ok: number }[]>`
      select 1 as ok
      from conversation
      where id = ${input.conversationId}
        and organization_id = ${input.organizationId}
      limit 1
    `;
    return conversation.length > 0;
  }

  if (input.target.kind === "member") {
    const rows = await sql<{ conversation_id: string }[]>`
      insert into conversation_assignment (
        conversation_id, organization_id, member_id, team_id, assigned_by
      )
      select c.id, c.organization_id, m.id, null, ${input.actorUserId}
      from conversation c
      join member m on m.organization_id = c.organization_id
      where c.id = ${input.conversationId}
        and c.organization_id = ${input.organizationId}
        and m.id = ${input.target.id}
        and m.suspended_at is null
      on conflict (conversation_id) do update
        set organization_id = excluded.organization_id,
            member_id = excluded.member_id,
            team_id = null,
            assigned_by = excluded.assigned_by,
            updated_at = now()
      returning conversation_id
    `;
    return rows.length > 0;
  }

  const rows = await sql<{ conversation_id: string }[]>`
    insert into conversation_assignment (
      conversation_id, organization_id, member_id, team_id, assigned_by
    )
    select c.id, c.organization_id, null, t.id, ${input.actorUserId}
    from conversation c
    join team t on t.organization_id = c.organization_id
    where c.id = ${input.conversationId}
      and c.organization_id = ${input.organizationId}
      and t.id = ${input.target.id}
    on conflict (conversation_id) do update
      set organization_id = excluded.organization_id,
          member_id = null,
          team_id = excluded.team_id,
          assigned_by = excluded.assigned_by,
          updated_at = now()
    returning conversation_id
  `;
  return rows.length > 0;
}
