/**
 * Hook de arranque de Next. El worker real vive en instrumentation-node.ts
 * para que el bundler edge no intente resolver dependencias de Node/Postgres.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootstrapDurableWorkers } = await import("./instrumentation-node");
    await bootstrapDurableWorkers();
  }
}
