import { startDurableWorkers } from "@/server/jobs/worker";

/**
 * Desde Wave 3 los runs no se marcan fallidos al reiniciar. La cola durable
 * recupera cualquier run "running" y los consumers continúan desde Postgres.
 */
export async function bootstrapDurableWorkers(): Promise<void> {
  try {
    await startDurableWorkers();
  } catch (err) {
    // La BD puede no estar lista todavía; el proceso no debe caer por el hook.
    // El siguiente arranque/reinicio vuelve a intentar y los jobs permanecen.
    console.error("[boot] arranque de workers durables falló:", err);
  }
}
