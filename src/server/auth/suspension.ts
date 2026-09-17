import { getSql } from "@/lib/db";
import { normalizeOrganizationRole, type OrganizationRole } from "@/lib/auth/roles";

export async function isMemberSuspended(
  organizationId: string,
  userId: string
): Promise<boolean> {
  const sql = getSql();
  const rows = await sql<{ suspended_at: Date | null }[]>`
    select suspended_at
    from member
    where organization_id = ${organizationId}
      and user_id = ${userId}
    limit 1
  `;
  return Boolean(rows[0]?.suspended_at);
}

export async function firstUnsuspendedMembership(
  userId: string
): Promise<{ organizationId: string; role: OrganizationRole } | null> {
  const sql = getSql();
  const rows = await sql<{ organization_id: string; role: string }[]>`
    select organization_id, role
    from member
    where user_id = ${userId}
      and suspended_at is null
    order by created_at asc, id asc
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  const role = normalizeOrganizationRole(row.role);
  return role ? { organizationId: row.organization_id, role } : null;
}

export async function setMemberSuspension(input: {
  organizationId: string;
  memberId: string;
  suspended: boolean;
  reason?: string | null;
  actorUserId: string;
}): Promise<{ userId: string; role: string; suspendedAt: Date | null } | null> {
  const sql = getSql();
  const rows = await sql<{
    user_id: string;
    role: string;
    suspended_at: Date | null;
  }[]>`
    update member
    set suspended_at = ${input.suspended ? new Date() : null},
        suspension_reason = ${input.suspended ? input.reason?.trim() || null : null},
        suspended_by = ${input.suspended ? input.actorUserId : null}
    where id = ${input.memberId}
      and organization_id = ${input.organizationId}
    returning user_id, role, suspended_at
  `;
  const row = rows[0];
  if (!row) return null;

  if (input.suspended) {
    // Revoca sesiones existentes. Si el usuario pertenece a otro tenant podrá
    // volver a iniciar sesión allí; requireSession seguirá bloqueando éste.
    await sql`delete from session where user_id = ${row.user_id}`;
  }

  return {
    userId: row.user_id,
    role: row.role,
    suspendedAt: row.suspended_at,
  };
}
