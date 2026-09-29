import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("jerarquía operativa de citas", () => {
  it("muestra citas antes que el bloqueo de horario", () => {
    const client = source("src/components/bookings/bookings-client.tsx");

    expect(client.indexOf("Citas <span")).toBeLessThan(client.indexOf("+ Bloquear un horario"));
  });

  it("mantiene el bloqueo cerrado por defecto y como acción secundaria", () => {
    const client = source("src/components/bookings/bookings-client.tsx");

    expect(client).toContain("const [showBlockForm, setShowBlockForm] = useState(false)");
    expect(client).toContain("Bloquear horario");
    expect(client).toContain("Ocultar bloqueo de horario");
  });

  it("orienta la creación de citas desde Mensajes", () => {
    const client = source("src/components/bookings/bookings-client.tsx");

    expect(client).toContain("Mensajes → Agendar cita");
  });
});
