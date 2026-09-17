import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  publish: vi.fn(),
  chatJson: vi.fn(),
  selectPredicates: [] as unknown[],
  updatePredicates: [] as unknown[],
}));

type Predicate =
  | { kind: "eq"; column: unknown; value: unknown }
  | { kind: "scoped"; organizationId: string; conditions: Predicate[] };

const ORG_A = "org_a";
const ORG_B = "org_b";
const CONV_B = "conv_b";

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

function scopedOrg(predicate: Predicate): string | undefined {
  return predicate.kind === "scoped" ? predicate.organizationId : undefined;
}

const conversationColumns = {
  organizationId: Symbol("conversation.organizationId"),
  id: Symbol("conversation.id"),
};

function conversationVisibleTo(predicate: Predicate) {
  const org = scopedOrg(predicate);
  const id = eqValue(predicate, conversationColumns.id);
  if (org === ORG_B && id === CONV_B) {
    return [
      {
        id: CONV_B,
        organizationId: ORG_B,
        handoffAt: new Date("2026-09-17T00:00:00Z"),
        aiEnabled: true,
        isTest: true,
      },
    ];
  }
  return [];
}

vi.mock("drizzle-orm", () => ({
  asc: (column: unknown) => ({ kind: "asc", column }),
  desc: (column: unknown) => ({ kind: "desc", column }),
  eq: (column: unknown, value: unknown): Predicate => ({ kind: "eq", column, value }),
}));

vi.mock("@/lib/db/tenant", () => ({
  scoped: (
    _organizationColumn: unknown,
    organizationId: string,
    ...conditions: Predicate[]
  ): Predicate => ({ kind: "scoped", organizationId, conditions }),
}));

vi.mock("@/lib/db", () => ({
  schema: {
    conversation: conversationColumns,
    message: {
      organizationId: Symbol("message.organizationId"),
      conversationId: Symbol("message.conversationId"),
      createdAt: Symbol("message.createdAt"),
    },
    agentProfile: { organizationId: Symbol("agentProfile.organizationId") },
    kbEntry: { organizationId: Symbol("kbEntry.organizationId") },
    pipelineStage: {
      organizationId: Symbol("pipelineStage.organizationId"),
      position: Symbol("pipelineStage.position"),
    },
    lead: {
      organizationId: Symbol("lead.organizationId"),
      contactId: Symbol("lead.contactId"),
    },
    contact: {
      organizationId: Symbol("contact.organizationId"),
      id: Symbol("contact.id"),
    },
  },
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: (predicate: Predicate) => {
          h.selectPredicates.push(predicate);
          const rows = conversationVisibleTo(predicate);
          return {
            limit: async () => rows,
            orderBy: async () => rows,
          };
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: (predicate: Predicate) => {
          h.updatePredicates.push(predicate);
          const rows = conversationVisibleTo(predicate);
          return { returning: async () => rows };
        },
      }),
    }),
    insert: vi.fn(),
  }),
}));

vi.mock("@/lib/db/ids", () => ({ newId: () => "test-id" }));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ AGENT_COALESCE_MS: 0 }),
  isAiConfigured: () => true,
}));
vi.mock("@/lib/ai", () => ({ chatJson: h.chatJson }));
vi.mock("@/server/events/bus", () => ({ publish: h.publish }));
vi.mock("@/server/leads/stage-history", () => ({ moveLeadToStage: vi.fn() }));
vi.mock("@/server/inbox/window", () => ({ isWindowOpen: () => true }));
vi.mock("@/server/inbox/send", () => ({
  SendError: class SendError extends Error {
    code = "test";
  },
  sendText: vi.fn(),
}));
vi.mock("@/server/ai/actions", () => ({
  agentActionSchema: vi.fn(),
  degradeAction: (x: unknown) => x,
  resolveStage: vi.fn(),
}));
vi.mock("@/server/ai/handoff", () => ({ matchesHandoffIntent: () => false }));
vi.mock("@/server/ai/prompts", () => ({ buildAgentSystemPrompt: () => "" }));
vi.mock("@/server/agenda/flag", () => ({ agendaEnabled: () => false }));
vi.mock("@/server/agenda/agent", () => ({
  bookSlot: vi.fn(),
  offerGeneralAvailability: vi.fn(),
  offerNextAvailable: vi.fn(),
  offerRange: vi.fn(),
  offerSlots: vi.fn(),
}));
vi.mock("@/server/agenda/offers", () => ({
  getOffers: async () => [],
  mapaDeHuecosParaModelo: () => null,
}));
vi.mock("@/server/agenda/settings", () => ({ getSettings: vi.fn() }));
vi.mock("@/lib/time/slots", () => ({
  todayInTz: () => "2026-09-17",
  todayLabelInTz: () => "17 sep 2026",
}));
vi.mock("@/server/agenda/schedule-intent", () => ({
  factualHoursReply: () => "",
  resolveScheduleIntent: () => ({ kind: "none" }),
}));
vi.mock("@/server/agenda/schedule-scope", () => ({
  resolveScheduleScope: () => null,
}));

describe("Wave 1 - cross-tenant behavior", () => {
  beforeEach(() => {
    h.publish.mockClear();
    h.chatJson.mockClear();
    h.selectPredicates.length = 0;
    h.updatePredicates.length = 0;
  });

  it("ORG_A no puede leer ni ejecutar el turno de una conversación de ORG_B", async () => {
    const { runAgentTurn } = await import("@/server/ai/pipeline");

    await runAgentTurn(CONV_B, ORG_A);

    expect(h.selectPredicates).toHaveLength(1);
    expect(scopedOrg(h.selectPredicates[0] as Predicate)).toBe(ORG_A);
    expect(eqValue(h.selectPredicates[0] as Predicate, conversationColumns.id)).toBe(
      CONV_B
    );
    expect(h.chatJson).not.toHaveBeenCalled();
    expect(h.updatePredicates).toHaveLength(0);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("el mismo id sí se resuelve cuando el tenant esperado es ORG_B", async () => {
    const { runAgentTurn } = await import("@/server/ai/pipeline");

    await runAgentTurn(CONV_B, ORG_B);

    expect(h.selectPredicates).toHaveLength(1);
    expect(scopedOrg(h.selectPredicates[0] as Predicate)).toBe(ORG_B);
    // La conversación existe, pero handoffAt hace que el turno termine antes del LLM.
    expect(h.chatJson).not.toHaveBeenCalled();
  });

  it("ORG_A no puede aplicar handoff sobre una conversación de ORG_B", async () => {
    const { applyHandoff } = await import("@/server/ai/pipeline");

    await applyHandoff(CONV_B, ORG_A, "cliente");

    expect(h.updatePredicates).toHaveLength(1);
    expect(scopedOrg(h.updatePredicates[0] as Predicate)).toBe(ORG_A);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("ORG_B sí puede aplicar handoff sobre su propia conversación", async () => {
    const { applyHandoff } = await import("@/server/ai/pipeline");

    await applyHandoff(CONV_B, ORG_B, "cliente");

    expect(h.updatePredicates).toHaveLength(1);
    expect(scopedOrg(h.updatePredicates[0] as Predicate)).toBe(ORG_B);
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledWith(
      ORG_B,
      expect.objectContaining({ type: "conversation.updated" })
    );
  });
});
