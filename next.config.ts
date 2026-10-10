import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// La versión sale de package.json y no de una constante aparte: duplicarla es
// tenerla desactualizada en uno de los dos lados, y justo esta no puede mentir.
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
) as { version: string };

const nextConfig: NextConfig = {
  // Fija el root al checkout actual. Sin esto, una lockfile ajena en un
  // directorio padre puede ampliar el tracing de producción por accidente.
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
  // standalone es para la imagen Docker (Linux). En Windows el trazado crea
  // symlinks que requieren permisos elevados, así que ahí se omite.
  output: process.platform === "win32" ? undefined : "standalone",
  // El paquete `postgres` usa APIs de Node que no deben empaquetarse en el bundle.
  serverExternalPackages: ["postgres"],
  // Se congelan al construir: el binario lleva dentro de qué código salió, así
  // que no puede mentir en tiempo de ejecución. `SOURCE_COMMIT` lo inyecta
  // Coolify solo; con docker compose se pasa por `--build-arg` y si falta, la
  // app enseña solo la versión.
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_BUILD_COMMIT: process.env.SOURCE_COMMIT ?? "",
  },
  // 0037 — la página pública de cotizaciones lleva el token en la URL: que
  // no se indexe, no se cachee y no viaje en el Referer. Las rutas de API de
  // /p y /api/p ya ponen estos encabezados en cada respuesta.
  async headers() {
    const privateLink = [
      { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Cache-Control", value: "no-store, max-age=0" },
    ];
    return [
      { source: "/p/:path*", headers: privateLink },
      { source: "/api/p/:path*", headers: privateLink },
    ];
  },
};

export default nextConfig;
