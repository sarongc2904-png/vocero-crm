import { eq } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";

/**
 * SEC-V1 / SEC-V2 / SEC-V4 — Pertenencia obligatoria de las referencias que
 * llegan del cliente.
 *
 * Las claves foráneas de este esquema son de **una sola columna**, así que son
 * globales: Postgres acepta que una fila del tenant A apunte a una fila del
 * tenant B. El `organization_id` que se escribe en el `INSERT` tampoco lo
 * impide, porque la fila referenciada no se mira. La única defensa es
 * comprobarlo explícitamente antes de escribir.
 *
 * Vive aquí, en un solo sitio, para que un camino nuevo (o el próximo
 * catálogo) no tenga que volver a recordar el patrón: `scoped()` protege la
 * fila propia, esto protege la referencia ajena.
 *
 * Contrato: lanza {@link TenantReferenceError} (404 en la API) en lugar de
 * devolver `null`, para que el olvido de comprobar el retorno no pueda
 * convertirse en una escritura silenciosa con un id ajeno.
 */
export class TenantReferenceError extends Error {
  readonly code = "not_found" as const;

  constructor(readonly label: string) {
    super(`${label} no pertenece a esta organización`);
    this.name = "TenantReferenceError";
  }
}

type TenantOwnedTable = PgTable & {
  id: PgColumn;
  organizationId: PgColumn;
};

async function requireOwnedRow(
  table: TenantOwnedTable,
  organizationId: string,
  id: string,
  label: string
): Promise<string> {
  const db = getDb();
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(scoped(table.organizationId, organizationId, eq(table.id, id)))
    .limit(1);

  const row = rows[0];
  if (!row) throw new TenantReferenceError(label);
  return String(row.id);
}

/** La etapa debe existir **en esta organización** (SEC-V1). */
export function requireTenantStage(
  organizationId: string,
  stageId: string
): Promise<string> {
  return requireOwnedRow(
    schema.pipelineStage as unknown as TenantOwnedTable,
    organizationId,
    stageId,
    "La etapa"
  );
}

/** El profesional debe existir **en esta organización** (SEC-V2). */
export function requireTenantProfessional(
  organizationId: string,
  professionalId: string
): Promise<string> {
  return requireOwnedRow(
    schema.professional as unknown as TenantOwnedTable,
    organizationId,
    professionalId,
    "El profesional"
  );
}

/** El contacto debe existir **en esta organización** (SEC-V4). */
export function requireTenantContact(
  organizationId: string,
  contactId: string
): Promise<string> {
  return requireOwnedRow(
    schema.contact as unknown as TenantOwnedTable,
    organizationId,
    contactId,
    "El contacto"
  );
}

/** El servicio debe existir **en esta organización**. */
export function requireTenantService(
  organizationId: string,
  serviceId: string
): Promise<string> {
  return requireOwnedRow(
    schema.service as unknown as TenantOwnedTable,
    organizationId,
    serviceId,
    "El servicio"
  );
}
