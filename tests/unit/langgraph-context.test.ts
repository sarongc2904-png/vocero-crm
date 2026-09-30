import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Predicate =
  | { kind: "eq"; column: unknown; value: unknown }
  | { kind: "scoped"; organizationId: string; conditions: Predicate[] };

const h = vi.hoisted(() => ({ predicates: [] as Predicate[] }));

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
    organizationId: Symbol("message.organizationId"),
    conversationId: Symbol("message.conversationId"),
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
  for (const condition of predicate.conditions) {
    const value = eqValue(condition, column);
    if (value !== undefined) return value;
  }
  return undefined;
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
    return [
      {
        direction: "in",
        text: "mensaje persistido",
        createdAt: new Date("2026-09-30T17:55:00.000Z"),
      },
    ];
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
            limit: async () => rows,
            orderBy: () =>
              table === tables.message
                ? { limit: async () => rows }
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
}));
vi.mock("@/server/agenda/pending-actions", () => ({
  peekPendingAction: vi.fn(),
}));
vi.mock("@/server/agenda/settings", () => ({ getSettings: vi.fn() }));
vi.mock("@/server/commercial/entitlement", () => ({
  hasCommercialAccess: vi.fn(),
}));
vi.mock("@/server/inbox/window", () => ({ isWindowOpen: () => true }));

describe("loadShadowContext tenant scope", () => {
  beforeEach(() => {
    h.predicates.length = 0;
  });

  it("carga la conversación del tenant correcto y deriva el inbound persistido", async () => {
    const { loadShadowContext } = await import("@/server/ai/graph/context");
    const result = await loadShadowContext({
      conversationId: "conv_1",
      expectedOrganizationId: "org_a",
      now: new Date("2026-09-30T18:00:00.000Z"),
    });

    expect(result.context?.conversation.organizationId).toBe("org_a");
    expect(result.context?.lastInboundText).toBe("mensaje persistido");
    expect(h.predicates[0]).toMatchObject({
      kind: "scoped",
      organizationId: "org_a",
    });
    expect(eqValue(h.predicates[0]!, tables.conversation.id)).toBe("conv_1");
  });

  it("no carga la misma conversación desde otro tenant", async () => {
    const { loadShadowContext } = await import("@/server/ai/graph/context");
    const result = await loadShadowContext({
      conversationId: "conv_1",
      expectedOrganizationId: "org_b",
      now: new Date("2026-09-30T18:00:00.000Z"),
    });

    expect(result.context).toBeNull();
    expect(h.predicates).toHaveLength(1);
    expect(h.predicates[0]).toMatchObject({
      kind: "scoped",
      organizationId: "org_b",
    });
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
