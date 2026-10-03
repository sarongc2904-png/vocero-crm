import { count } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";

/**
 * Registro público cerrado tras la primera organización (FR-060). Se abre de
 * forma explícita con PUBLIC_SIGNUP=open. ALLOW_SIGNUP=true se conserva como
 * compatibilidad únicamente cuando el flag nuevo no está definido.
 */
export async function isPublicSignupAllowed(): Promise<boolean> {
  if (isPublicSignupExplicitlyOpen()) return true;
  const db = getDb();
  const rows = await db.select({ n: count() }).from(schema.organization);
  return (rows[0]?.n ?? 0) === 0;
}

export function isPublicSignupExplicitlyOpen(): boolean {
  const publicSignup = process.env.PUBLIC_SIGNUP?.trim().toLowerCase();
  if (publicSignup === "open") return true;
  return !publicSignup && process.env.ALLOW_SIGNUP === "true";
}
