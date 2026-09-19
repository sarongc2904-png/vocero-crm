import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    // Varias pruebas E2E unitarias cargan el pipeline completo y usan timeouts
    // estrictos. En runners pequeños, 64 archivos en paralelo se roban CPU y
    // generan falsos timeouts; serial conserva los mismos casos y contratos.
    fileParallelism: false,
    maxWorkers: 1,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
});
