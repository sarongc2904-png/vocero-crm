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
    expect(wizard).toContain("WhatsApp no conectado");
    expect(wizard).toContain("WhatsApp conectado");
    expect(wizard).toContain("reconnect_required");
    expect(wizard).toContain('status === "error"');
    expect(wizard).toContain("Reconectar WhatsApp");
    expect(wizard).toContain("Desconectar WhatsApp");
  });

  it("conserva la conexión manual cuando Embedded Signup no está disponible", () => {
    const wizard = source("src/components/settings/whatsapp-wizard.tsx");

    expect(wizard).toContain("!embeddedSignup.available");
    expect(wizard).toContain("<ConnectForm existing={connection}");
    expect(wizard).toContain("La conexión guiada no está disponible");
  });

  it("no expone tokens y limpia intentos cancelados de Embedded Signup", () => {
    const wizard = source("src/components/settings/whatsapp-wizard.tsx");
    const button = source(
      "src/components/settings/embedded-signup-button.tsx"
    );
    const route = source("src/app/api/settings/whatsapp/route.ts");

    expect(wizard).not.toContain("tokenLast4");
    expect(route).not.toContain("tokenLast4");
    expect(button).toContain("resetAttempt();");
    // La lectura del postMessage vive en el parser puro; el botón reinicia.
    const parser = source("src/lib/meta/embedded-signup-message.ts");
    expect(parser).toContain('payload.event === "CANCEL"');
    expect(button).toContain('message.kind === "cancel"');
    expect(button).toContain("state: stateRef.current");
    expect(button).toContain('fetch("/api/settings/whatsapp")');
    expect(button).toContain("script.onerror");
  });
});
