import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import type { SessionContext } from "@/lib/auth/session";

export async function auditPrivilegedAction(
  session: SessionContext,
  input: {
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    metadata?: Record<string, unknown> | null;
  }
): Promise<void> {
  const sql = getSql();
  // Next puede cargar postgres-js y este módulo en realms distintos. Pasar el
  // wrapper de `sql.json(object)` a través de ese límite termina tratado como
  // Buffer por la otra copia del driver. El texto JSON es neutral al realm y
  // el cast explícito conserva el tipo jsonb de la columna.
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

  await sql`
    insert into privileged_audit_log (
      id,
      organization_id,
      actor_user_id,
      actor_mode,
      action,
      target_type,
      target_id,
      metadata
    ) values (
      ${`audit_${randomUUID()}`},
      ${session.organizationId},
      ${session.userId},
      ${session.isSuperadmin ? "superadmin" : "member"},
      ${input.action},
      ${input.targetType ?? null},
      ${input.targetId ?? null},
      ${metadataJson}::jsonb
    )
  `;
}

export type PrivilegedAuditRow = {
  id: string;
  actorUserId: string | null;
  actorMode: "member" | "superadmin";
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};

export async function listPrivilegedAudit(
  organizationId: string,
  limit = 100
): Promise<PrivilegedAuditRow[]> {
  const sql = getSql();
  const safeLimit = Math.max(1, Math.min(250, Math.trunc(limit)));
  const rows = await sql<{
    id: string;
    actor_user_id: string | null;
    actor_mode: "member" | "superadmin";
    action: string;
    target_type: string | null;
    target_id: string | null;
    metadata: Record<string, unknown> | null;
    created_at: Date;
  }[]>`
    select id, actor_user_id, actor_mode, action, target_type, target_id, metadata, created_at
    from privileged_audit_log
    where organization_id = ${organizationId}
    order by created_at desc
    limit ${safeLimit}
  `;

  return rows.map((row) => ({
    id: row.id,
    actorUserId: row.actor_user_id,
    actorMode: row.actor_mode,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: row.metadata,
    createdAt: row.created_at,
  }));
}
