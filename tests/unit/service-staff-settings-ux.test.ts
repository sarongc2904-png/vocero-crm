import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("configuración guiada de servicios y personal", () => {
  it("presenta el flujo en tres pasos claros", () => {
    const settings = source("src/components/settings/beauty-settings-client.tsx");

    expect(settings).toContain("1. Servicios");
    expect(settings).toContain("2. Personal");
    expect(settings).toContain("3. Horarios y ausencias");
    expect(settings).toContain("Primero agrega al menos un servicio.");
    expect(settings).toContain("Aún no has agregado personal");
  });

  it("detecta la zona horaria sin pedirla en el formulario principal", () => {
    const settings = source("src/components/settings/beauty-settings-client.tsx");

    expect(settings).toContain("Intl.DateTimeFormat().resolvedOptions().timeZone");
    expect(settings).toContain("La zona horaria se detecta automáticamente");
    expect(settings).not.toContain('<Field label="Zona horaria">');
  });
});
