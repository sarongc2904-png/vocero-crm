import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("ajustes de WhatsApp simplificados", () => {
  it("prioriza Embedded Signup y oculta detalles técnicos por defecto", () => {
    const wizard = source("src/components/settings/whatsapp-wizard.tsx");

    expect(wizard).toContain("Conectar WhatsApp");
    expect(wizard).toContain("Conexión guiada por Meta");
    expect(wizard).toContain("Opciones avanzadas");
    expect(wizard).toContain("showAdvanced");
    expect(wizard).toContain("<WebhookCard webhook={webhook} />");
  });

  it("conserva la conexión manual cuando Embedded Signup no está disponible", () => {
    const wizard = source("src/components/settings/whatsapp-wizard.tsx");

    expect(wizard).toContain("!embeddedSignup.available");
    expect(wizard).toContain("<ConnectForm existing={connection}");
    expect(wizard).toContain("La conexión guiada no está disponible");
  });
});
