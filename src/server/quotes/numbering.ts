import { sql } from "drizzle-orm";
import type { getDb } from "@/lib/db";
import { schema } from "@/lib/db";

/** Folio visible: COT-0001. Pasado 9999 simplemente crece (COT-10000). */
export function formatQuoteFolio(number: number): string {
  return `COT-${String(number).padStart(4, "0")}`;
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * Toma el siguiente folio del negocio DENTRO de la transacción que crea la
 * cotización. El upsert bloquea la fila del contador hasta el commit, así que
 * dos altas simultáneas del mismo negocio se serializan y nunca comparten
 * número; si la transacción se revierte, el número no se consume.
 */
export async function takeNextQuoteNumber(tx: Tx, organizationId: string): Promise<number> {
  if (!organizationId) throw new Error("takeNextQuoteNumber(): organizationId vacío");
  const rows = await tx
    .insert(schema.quoteCounter)
    .values({ organizationId, lastNumber: 1 })
    .onConflictDoUpdate({
      target: schema.quoteCounter.organizationId,
      set: {
        lastNumber: sql`${schema.quoteCounter.lastNumber} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning({ number: schema.quoteCounter.lastNumber });
  const number = rows[0]?.number;
  if (!number) throw new Error("takeNextQuoteNumber(): el contador no devolvió número");
  return number;
}
