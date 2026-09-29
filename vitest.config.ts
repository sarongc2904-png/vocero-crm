import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // Next compila JSX con el runtime automático (sin `import React` en cada
  // archivo). Sin esto, esbuild usa el runtime clásico y cualquier prueba que
  // renderice un componente o layout falla con "React is not defined".
  esbuild: { jsx: "automatic" },
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
