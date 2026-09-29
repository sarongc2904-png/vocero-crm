import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("directorio de clientes", () => {
  it("usa lenguaje consistente de clientes", () => {
    const client = source("src/components/contacts/contacts-client.tsx");

    expect(client).toContain(">Clientes</h2>");
    expect(client).toContain("Editar cliente");
    expect(client).not.toContain("Editar contacto");
  });

  it("hace explícita la acción principal de abrir conversación", () => {
    const client = source("src/components/contacts/contacts-client.tsx");

    expect(client).toContain("Abrir conversación");
    expect(client).toContain('variant="secondary"');
    expect(client).toContain("MessageSquareText");
  });
});
