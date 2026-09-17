import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";

export type TeamRow = {
  id: string;
  name: string;
  members: Array<{
    memberId: string;
    userId: string;
    name: string;
    email: string;
    role: string;
  }>;
};

export async function listTeams(organizationId: string): Promise<TeamRow[]> {
  const sql = getSql();
  const teams = await sql<{ id: string; name: string }[]>`
    select id, name
    from team
    where organization_id = ${organizationId}
    order by lower(name), id
  `;
  if (teams.length === 0) return [];

  const memberships = await sql<{
    team_id: string;
    member_id: string;
    user_id: string;
    name: string;
    email: string;
    role: string;
  }[]>`
    select tm.team_id, m.id as member_id, m.user_id, u.name, u.email, m.role
    from team_member tm
    join team t
      on t.id = tm.team_id
     and t.organization_id = tm.organization_id
    join member m
      on m.id = tm.member_id
     and m.organization_id = tm.organization_id
    join "user" u on u.id = m.user_id
    where tm.organization_id = ${organizationId}
    order by u.name, u.email
  `;

  const byTeam = new Map<string, TeamRow["members"]>();
  for (const membership of memberships) {
    const bucket = byTeam.get(membership.team_id) ?? [];
    bucket.push({
      memberId: membership.member_id,
      userId: membership.user_id,
      name: membership.name,
      email: membership.email,
      role: membership.role,
    });
    byTeam.set(membership.team_id, bucket);
  }

  return teams.map((team) => ({
    ...team,
    members: byTeam.get(team.id) ?? [],
  }));
}

export async function createTeam(
  organizationId: string,
  name: string
): Promise<{ id: string; name: string }> {
  const sql = getSql();
  const id = `team_${randomUUID()}`;
  const cleanName = name.trim();
  const rows = await sql<{ id: string; name: string }[]>`
    insert into team (id, organization_id, name)
    values (${id}, ${organizationId}, ${cleanName})
    returning id, name
  `;
  return rows[0]!;
}

export async function renameTeam(input: {
  organizationId: string;
  teamId: string;
  name: string;
}): Promise<boolean> {
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`
    update team
    set name = ${input.name.trim()}, updated_at = now()
    where id = ${input.teamId}
      and organization_id = ${input.organizationId}
    returning id
  `;
  return rows.length > 0;
}

export async function deleteTeam(
  organizationId: string,
  teamId: string
): Promise<boolean> {
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`
    delete from team
    where id = ${teamId}
      and organization_id = ${organizationId}
    returning id
  `;
  return rows.length > 0;
}

export async function addMemberToTeam(input: {
  organizationId: string;
  teamId: string;
  memberId: string;
}): Promise<boolean> {
  const sql = getSql();
  const rows = await sql<{ team_id: string }[]>`
    insert into team_member (team_id, organization_id, member_id)
    select t.id, t.organization_id, m.id
    from team t
    join member m on m.organization_id = t.organization_id
    where t.id = ${input.teamId}
      and t.organization_id = ${input.organizationId}
      and m.id = ${input.memberId}
      and m.suspended_at is null
    on conflict (team_id, member_id) do nothing
    returning team_id
  `;
  if (rows.length > 0) return true;

  const existing = await sql<{ ok: number }[]>`
    select 1 as ok
    from team_member
    where team_id = ${input.teamId}
      and member_id = ${input.memberId}
      and organization_id = ${input.organizationId}
    limit 1
  `;
  return existing.length > 0;
}

export async function removeMemberFromTeam(input: {
  organizationId: string;
  teamId: string;
  memberId: string;
}): Promise<boolean> {
  const sql = getSql();
  const rows = await sql<{ team_id: string }[]>`
    delete from team_member
    where team_id = ${input.teamId}
      and member_id = ${input.memberId}
      and organization_id = ${input.organizationId}
    returning team_id
  `;
  return rows.length > 0;
}
