import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";

/**
 * ONB-1 — El botón "Cargar datos de demostración" no puede destruir trabajo
 * real sin confirmación.
 *
 * El seed borra TODA la base de conocimiento, TODAS las corridas y casos del
 * Laboratorio, y sobreescribe la identidad del agente. El guard anterior solo
 * miraba si había CONTACTOS, así que el caso más común de un cliente nuevo
 * —configurar el conocimiento y el agente antes de conectar WhatsApp— pasaba el
 * filtro y se perdía completo con un clic.
 */

type Row = Record<string, unknown>;

/**
 * Stub mínimo de la base: devuelve las filas por tabla e ignora el `where`.
 * El aislamiento por organización de estas consultas ya está cubierto por
 * `tests/unit/seed-demo-tenant-isolation.test.ts`.
 */
function fakeDb(state: Record<string, Row[]>) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () =>
            Promise.resolve((state[getTableName(table as never)] ?? []).slice(0, 1)),
        }),
      }),
    }),
  };
}

async function blockersFor(state: Record<string, Row[]>) {
  const { getDemoSeedBlockers } = await import("@/server/seed/demo");
  return getDemoSeedBlockers(fakeDb(state) as never, "org_1");
}

describe("ONB-1 · qué bloquea la carga de la demo", () => {
  it("una organización vacía no tiene bloqueos", async () => {
    expect(await blockersFor({})).toEqual([]);
  });

  it("con conocimiento y agente configurados pero SIN contactos: bloquea (el bug)", async () => {
    const blockers = await blockersFor({
      kb_entry: [{ id: "kb1" }],
      agent_profile: [
        {
          name: "Martillito",
          tone: "Cercano",
          instructions: "Cotiza en MXN",
          escalationRules: null,
          greeting: "¡Hola!",
        },
      ],
    });

    // Antes esto devolvía "vacío" porque no había contactos, y el seed borraba
    // el conocimiento y sobrescribía al agente.
    expect(blockers).toContain("kb");
    expect(blockers).toContain("agent_profile");
    expect(blockers).not.toContain("contacts");
  });

  it("bloquea si hay corridas o casos del Laboratorio", async () => {
    expect(await blockersFor({ agent_test_run: [{ id: "run1" }] })).toContain("lab");
    expect(await blockersFor({ agent_test_case: [{ id: "case1" }] })).toContain("lab");
  });

  it("bloquea si hay contactos, conversaciones o mensajes", async () => {
    expect(await blockersFor({ contact: [{ id: "c1" }] })).toContain("contacts");
    expect(
      await blockersFor({ conversation: [{ id: "conv1" }] })
    ).toContain("conversations");
    expect(await blockersFor({ message: [{ id: "m1" }] })).toContain(
      "conversations"
    );
  });

  it("un perfil de agente recién creado (sin configurar) NO bloquea", async () => {
    const blockers = await blockersFor({
      agent_profile: [
        {
          name: "Asistente",
          tone: null,
          instructions: null,
          escalationRules: null,
          greeting: null,
        },
      ],
    });

    expect(blockers).toEqual([]);
  });

  it("un perfil con solo el saludo cambiado ya bloquea", async () => {
    const blockers = await blockersFor({
      agent_profile: [
        {
          name: "Asistente",
          tone: null,
          instructions: null,
          escalationRules: null,
          greeting: "Hola, soy tu asistente",
        },
      ],
    });

    expect(blockers).toContain("agent_profile");
  });

  it("isDomainEmpty es exactamente «no hay bloqueos»", async () => {
    const { isDomainEmpty } = await import("@/server/seed/demo");

    await expect(
      isDomainEmpty(fakeDb({ kb_entry: [{ id: "kb1" }] }) as never, "org_1")
    ).resolves.toBe(false);
    await expect(
      isDomainEmpty(fakeDb({}) as never, "org_1")
    ).resolves.toBe(true);
  });
});
