import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("errores de carga de la bandeja", () => {
  it("muestra y permite reintentar el fallo al cargar conversaciones", () => {
    const inbox = source("src/components/inbox/inbox-client.tsx");
    const list = source("src/components/inbox/conversation-list.tsx");

    expect(inbox).toContain("setConversationsError");
    expect(inbox).toContain('loadError={conversationsError}');
    expect(list).toContain('role="alert"');
    expect(list).toContain("onClick={onRetry}");
    expect(list).toContain("loadError ? null");
  });

  it("distingue un historial vacío de un historial que no pudo cargar", () => {
    const inbox = source("src/components/inbox/inbox-client.tsx");

    expect(inbox).toContain("setMessagesError");
    expect(inbox).toContain("No se pudo cargar el historial de mensajes.");
    expect(inbox).toContain("refetchMessages(selected.id)");
  });
});
