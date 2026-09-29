import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("separación entre agenda general y horarios del personal", () => {
  it("nombra la pestaña como Agenda general", () => {
    const nav = source("src/components/settings/settings-nav.tsx");

    expect(nav).toContain('label: "Agenda general"');
  });

  it("explica cuándo usar la agenda general y enlaza servicios y personal", () => {
    const agenda = source("src/components/settings/agenda-client.tsx");

    expect(agenda).toContain("Esta configuración se usa cuando una cita no tiene un servicio y una");
    expect(agenda).toContain("Servicios y personal");
    expect(agenda).toContain('href="/settings/beauty"');
    expect(agenda).toContain("Horario general");
    expect(agenda).toContain("Reglas de la agenda general");
  });
});
