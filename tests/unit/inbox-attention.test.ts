import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("bandeja orientada a atención", () => {
  it("calcula conversaciones sin respuesta y seguimientos vencidos", () => {
    const queries = source("src/server/inbox/queries.ts");

    expect(queries).toContain("needsReply30mSql");
    expect(queries).toContain("interval '30 minutes'");
    expect(queries).toContain("nextActionTypeSql");
    expect(queries).toContain("nextActionAtSql");
    expect(queries).toContain("nextActionOverdue");
  });

  it("permite ver solo lo que requiere atención", () => {
    const list = source("src/components/inbox/conversation-list.tsx");

    expect(list).toContain('"attention"');
    expect(list).toContain("Requieren atención");
    expect(list).toContain("Sin respuesta");
    expect(list).toContain("Seguimiento vencido");
    expect(list).toContain("Atención humana");
  });

  it("mantiene mensajes como pantalla inicial", () => {
    const home = source("src/app/page.tsx");
    const login = source("src/app/(auth)/login/page.tsx");

    expect(home).toContain('redirect("/inbox")');
    expect(login).toContain('router.push("/inbox")');
  });
});
