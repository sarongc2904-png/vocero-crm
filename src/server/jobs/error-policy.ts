import { SendError } from "@/server/inbox/send";
import type { DurableJobKind } from "@/server/jobs/queue";

/**
 * Errores que no pueden sanar con backoff. Un token marcado para reconexión
 * requiere intervención del dueño; repetir el turno solo vuelve a ejecutar la
 * IA y sus posibles efectos laterales con la misma credencial inválida.
 */
export function isPermanentJobError(
  kind: DurableJobKind,
  error: unknown
): boolean {
  return (
    kind === "agent_turn" &&
    error instanceof SendError &&
    error.code === "reconnect_required"
  );
}
