import { createHash } from "node:crypto";

/**
 * Hash irreversible usado para identificar enlaces públicos sin conservar el
 * token en claro. Este módulo no importa persistencia y puede usarse desde el
 * Middleware de Node.js.
 */
export function hashQuoteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
