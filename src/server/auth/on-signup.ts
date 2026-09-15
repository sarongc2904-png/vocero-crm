import { count, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import {
  initializeOrganization,
  resolveActiveMembership,
} from "@/server/auth/organizations";

/**
 * Primer registro de la instancia: crea la organización, deja al usuario como
 * propietario y siembra pipeline + perfil del agente.
 *
 * Solo actúa si NO existe ninguna organización (las cuentas de equipo las crea
 * el propietario y reciben su membresía explícita). Un advisory lock evita que
 * dos registros simultáneos en instancia vacía creen dos organizaciones.
 */
export async function onUserCreated(userId: string, userName: string) {
  const db = getDb();
  await db.transaction(async (tx) => {
    // Lock transaccional de "primer arranque" (clave arbitraria fija):
    // dos registros simultáneos en instancia vacía → solo uno crea la org.
    await tx.execute(sql`select pg_advisory_xact_lock(874201)`);
    const [orgs] = await tx
      .select({ n: count() })
      .from(schema.organization);
    if ((orgs?.n ?? 0) > 0) return;

    const orgId = newId("organization");
    await initializeOrganization(tx, {
      organizationId: orgId,
      ownerUserId: userId,
      name: userName ? `Negocio de ${userName}` : "Mi negocio",
      slug: "principal",
    });
  });
}

/** Organización activa de un usuario (su primera membresía). */
export async function resolveActiveOrganizationId(
  userId: string
): Promise<string | null> {
  return (await resolveActiveMembership(userId, null))?.organizationId ?? null;
}

/** @deprecated Usa resolveActiveMembership(userId, activeOrganizationId). */
export async function resolveMembership(
  userId: string
): Promise<{ organizationId: string; role: string } | null> {
  return resolveActiveMembership(userId, null);
}
