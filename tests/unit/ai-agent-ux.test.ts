import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("Agente IA para usuarios no técnicos", () => {
  it("usa lenguaje operativo y consistente", () => {
    const agent = source("src/components/agent/agent-client.tsx");

    expect(agent).toContain(">Agente IA</h2>");
    expect(agent).toContain("Cuándo pasar a una persona");
    expect(agent).toContain("Conocimiento del negocio");
    expect(agent).toContain("Pregunta frecuente");
    expect(agent).toContain("Información adicional");
  });

  it("no expone configuración interna del proveedor en la interfaz principal", () => {
    const agent = source("src/components/agent/agent-client.tsx");

    expect(agent).not.toContain("OPENROUTER_API_TOKEN");
    expect(agent).not.toContain("OPENROUTER_MODEL");
    expect(agent).not.toContain("Knowledge base");
    expect(agent).not.toContain("límite del contexto del modelo");
  });
});
