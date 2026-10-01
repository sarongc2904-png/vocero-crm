import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Predicate =
  | { kind: "eq"; column: unknown; value: unknown }
  | { kind: "gte"; column: unknown; value: unknown }
  | { kind: "lt"; column: unknown; value: unknown }
  | { kind: "ne"; column: unknown; value: unknown }
  | { kind: "scoped"; organizationId: string; conditions: Predicate[] };

type MessageRow = {
  id: string;
  organizationId: string;
  conversationId: string;
  direction: "in" | "out";
  text: string;
  createdAt: Date;
};

const h = vi.hoisted(() => ({
  predicates: [] as Predicate[],
  messages: [] as MessageRow[],
}));

const tables = vi.hoisted(() => ({
  conversation: {
    table: "conversation",
    id: Symbol("conversation.id"),
    organizationId: Symbol("conversation.organizationId"),
  },
  agentProfile: {
    table: "agentProfile",
    organizationId: Symbol("agentProfile.organizationId"),
  },
  message: {
    table: "message",
    id: Symbol("message.id"),
    organizationId: Symbol("message.organizationId"),
    conversationId: Symbol("message.conversationId"),
    direction: Symbol("message.direction"),
    createdAt: Symbol("message.createdAt"),
  },
  kbEntry: {
    table: "kbEntry",
    organizationId: Symbol("kbEntry.organizationId"),
    createdAt: Symbol("kbEntry.createdAt"),
  },
  pipelineStage: {
    table: "pipelineStage",
    id: Symbol("pipelineStage.id"),
    name: Symbol("pipelineStage.name"),
    organizationId: Symbol("pipelineStage.organizationId"),
    position: Symbol("pipelineStage.position"),
  },
}));

function eqValue(predicate: Predicate, column: unknown): unknown {
  if (predicate.kind === "eq") {
    return predicate.column === column ? predicate.value : undefined;
  }
  if (predicate.kind !== "scoped") return undefined;
  for (const condition of predicate.conditions) {
    const value = eqValue(condition, column);
    if (value !== undefined) return value;
  }
  return undefined;
}

function columnValue(row: MessageRow, column: unknown): unknown {
  if (column === tables.message.id) return row.id;
  if (column === tables.message.organizationId) return row.organizationId;
  if (column === tables.message.conversationId) return row.conversationId;
  if (column === tables.message.direction) return row.direction;
  if (column === tables.message.createdAt) return row.createdAt;
  return undefined;
}

function matchesMessage(row: MessageRow, predicate: Predicate): boolean {
  if (predicate.kind === "scoped") {
    return (
      row.organizationId === predicate.organizationId &&
      predicate.conditions.every((condition) => matchesMessage(row, condition))
    );
  }
  const actual = columnValue(row, predicate.column);
  if (predicate.kind === "eq") return actual === predicate.value;
  if (predicate.kind === "ne") return actual !== predicate.value;
  const actualTime = actual instanceof Date ? actual.getTime() : Number(actual);
  const expectedTime =
    predicate.value instanceof Date
      ? predicate.value.getTime()
      : Number(predicate.value);
  return predicate.kind === "gte"
    ? actualTime >= expectedTime
    : actualTime < expectedTime;
}

function rowsFor(table: { table: string }, predicate: Predicate) {
  if (table === tables.conversation) {
    const organizationId =
      predicate.kind === "scoped" ? predicate.organizationId : undefined;
    const conversationId = eqValue(predicate, tables.conversation.id);
    return organizationId === "org_a" && conversationId === "conv_1"
      ? [
          {
            id: "conv_1",
            organizationId: "org_a",
            contactId: "contact_1",
            isTest: true,
            aiEnabled: true,
            handoffAt: null,
            lastInboundAt: new Date("2026-09-30T17:55:00.000Z"),
          },
        ]
      : [];
  }
  if (table === tables.agentProfile) {
    return [
      {
        id: "profile_1",
        organizationId: "org_a",
        enabled: true,
        name: "Asistente",
        tone: null,
        instructions: null,
        escalationRules: null,
        greeting: null,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
        updatedAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    ];
  }
  if (table === tables.message) {
    return h.messages
      .filter((row) => matchesMessage(row, predicate))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  return [];
}

vi.mock("drizzle-orm", () => ({
  asc: (column: unknown) => ({ kind: "asc", column }),
  desc: (column: unknown) => ({ kind: "desc", column }),
  eq: (column: unknown, value: unknown): Predicate => ({
    kind: "eq",
    column,
    value,
  }),
  gte: (column: unknown, value: unknown): Predicate => ({
    kind: "gte",
    column,
    value,
  }),
  lt: (column: unknown, value: unknown): Predicate => ({
    kind: "lt",
    column,
    value,
  }),
  ne: (column: unknown, value: unknown): Predicate => ({
    kind: "ne",
    column,
    value,
  }),
}));

vi.mock("@/lib/db/tenant", () => ({
  scoped: (
    _organizationColumn: unknown,
    organizationId: string,
    ...conditions: Predicate[]
  ): Predicate => ({ kind: "scoped", organizationId, conditions }),
}));

vi.mock("@/lib/db", () => ({
  schema: tables,
  getDb: () => ({
    select: () => ({
      from: (table: { table: string }) => ({
        where: (predicate: Predicate) => {
          h.predicates.push(predicate);
          const rows = rowsFor(table, predicate);
          return {
            limit: async (count: number) => rows.slice(0, count),
            orderBy: () =>
              table === tables.message
                ? { limit: async (count: number) => rows.slice(0, count) }
                : Promise.resolve(rows),
          };
        },
      }),
    }),
  }),
}));

vi.mock("@/server/agenda/flag", () => ({ agendaEnabled: () => false }));
vi.mock("@/server/agenda/offers", () => ({
  currentOffers: vi.fn(),
  getOffers: vi.fn(),
  mapaDeHuecosParaModelo: vi.fn(() => null),
}));
vi.mock("@/server/agenda/pending-actions", () => ({
  peekPendingAction: vi.fn(),
}));
vi.mock("@/server/agenda/settings", () => ({
  DEFAULT_TIMEZONE: "UTC",
  getSettings: vi.fn(),
}));
vi.mock("@/server/commercial/entitlement", () => ({
  hasCommercialAccess: vi.fn(),
}));
vi.mock("@/server/inbox/window", () => ({ isWindowOpen: () => true }));

describe("loadShadowContext tenant scope", () => {
  beforeEach(() => {
    h.predicates.length = 0;
    h.messages = [
      {
        id: "msg_in_1",
        organizationId: "org_a",
        conversationId: "conv_1",
        direction: "in",
        text: "mensaje persistido",
        createdAt: new Date("2026-09-30T17:55:00.000Z"),
      },
    ];
  });

  it("carga la conversación del tenant correcto y deriva el inbound persistido", async () => {
    const { loadShadowContext } = await import("@/server/ai/graph/context");
    const result = await loadShadowContext({
      conversationId: "conv_1",
      expectedOrganizationId: "org_a",
      expectedInboundMessageId: "msg_in_1",
      now: new Date("2026-09-30T18:00:00.000Z"),
    });

    expect(result.context?.conversation.organizationId).toBe("org_a");
    expect(result.context?.lastInboundMessageId).toBe("msg_in_1");
    expect(result.context?.lastInboundText).toBe("mensaje persistido");
    expect(h.predicates[0]).toMatchObject({
      kind: "scoped",
      organizationId: "org_a",
    });
    expect(eqValue(h.predicates[0]!, tables.conversation.id)).toBe("conv_1");
    expect(h.predicates[1]).toMatchObject({
      kind: "scoped",
      organizationId: "org_a",
    });
    expect(eqValue(h.predicates[1]!, tables.message.conversationId)).toBe(
      "conv_1"
    );
    expect(eqValue(h.predicates[1]!, tables.message.direction)).toBe("in");
  });

  it("no carga la misma conversación desde otro tenant", async () => {
    const { loadShadowContext } = await import("@/server/ai/graph/context");
    const result = await loadShadowContext({
      conversationId: "conv_1",
      expectedOrganizationId: "org_b",
      expectedInboundMessageId: "msg_in_1",
      now: new Date("2026-09-30T18:00:00.000Z"),
    });

    expect(result.context).toBeNull();
    expect(h.predicates).toHaveLength(1);
    expect(h.predicates[0]).toMatchObject({
      kind: "scoped",
      organizationId: "org_b",
    });
  });

  it("bloquea A cuando ya existe un inbound B posterior", async () => {
    h.messages.push({
      id: "msg_in_2",
      organizationId: "org_a",
      conversationId: "conv_1",
      direction: "in",
      text: "mensaje B",
      createdAt: new Date("2026-09-30T17:56:00.000Z"),
    });
    const { loadShadowContext } = await import("@/server/ai/graph/context");
    const result = await loadShadowContext({
      conversationId: "conv_1",
      expectedOrganizationId: "org_a",
      expectedInboundMessageId: "msg_in_1",
      now: new Date("2026-09-30T18:00:00.000Z"),
    });

    expect(result.failureReason).toBe("inbound_mismatch");
    expect(result.context).toBeNull();
  });

  it("impide que B llegue al modelo durante una ejecución shadow de A", async () => {
    h.messages.push({
      id: "msg_in_2",
      organizationId: "org_a",
      conversationId: "conv_1",
      direction: "in",
      text: "mensaje B",
      createdAt: new Date("2026-09-30T17:56:00.000Z"),
    });
    const proposeAction = vi.fn(async () => ({ action: "reply", text: "no" }));
    const { runShadowAgent } = await import("@/server/ai/graph/graph");
    const result = await runShadowAgent(
      {
        conversationId: "conv_1",
        expectedOrganizationId: "org_a",
        expectedInboundMessageId: "msg_in_1",
      },
      { dependencies: { proposeAction } }
    );

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("inbound_mismatch");
    expect(result.wouldExecute).toBeNull();
    expect(result.wouldReply).toBeNull();
    expect(proposeAction).not.toHaveBeenCalled();
  });

  it("termina history exactamente en el inbound esperado", async () => {
    h.messages.unshift({
      id: "msg_old",
      organizationId: "org_a",
      conversationId: "conv_1",
      direction: "out",
      text: "mensaje anterior",
      createdAt: new Date("2026-09-30T17:54:00.000Z"),
    });
    const { loadShadowContext } = await import("@/server/ai/graph/context");
    const result = await loadShadowContext({
      conversationId: "conv_1",
      expectedOrganizationId: "org_a",
      expectedInboundMessageId: "msg_in_1",
      now: new Date("2026-09-30T18:00:00.000Z"),
    });

    expect(result.context?.history).toEqual([
      { role: "assistant", content: "mensaje anterior" },
      { role: "user", content: "mensaje persistido" },
    ]);
  });

  it("no conserva un fallback de consulta sólo por conversationId", async () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/server/ai/graph/context.ts"),
      "utf8"
    );

    expect(source).not.toContain(
      ": eq(schema.conversation.id, input.conversationId)"
    );
    expect(source).toContain(
      "schema.conversation.organizationId,\n        input.expectedOrganizationId"
    );
  });
});
