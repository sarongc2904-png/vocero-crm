import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("tablero de prospectos", () => {
  it("usa Prospectos como título principal", () => {
    const board = source("src/components/pipeline/pipeline-client.tsx");

    expect(board).toContain(">Prospectos</h2>");
    expect(board).not.toContain(">Pipeline</h2>");
    expect(board).toContain("Mueve cada prospecto según avance la conversación.");
  });

  it("mantiene la configuración de etapas como acción secundaria", () => {
    const board = source("src/components/pipeline/pipeline-client.tsx");

    expect(board).toContain('variant="ghost"');
    expect(board).toContain("Configurar etapas");
  });

  it("muestra un estado vacío claro en cada etapa", () => {
    const board = source("src/components/pipeline/pipeline-client.tsx");

    expect(board).toContain("Sin prospectos en esta etapa");
  });
});
