import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Column = { table: string; name: string };
type Table = Record<string, Column> & { __name: string };
type Condition =
  | { op: "eq"; column: Column; value: unknown }
  | { op: "in"; column: Column; values: unknown[] }
  | { op: "and"; conditions: Condition[] };

const mocked = vi.hoisted(() => {
  const table = (name: string, columns: string[]) => {
    const value: Record<string, unknown> = { __name: name };
    for (const column of columns) value[column] = { table: name, name: column };
    return value;
  };

  return {
    schema: {
      contact: table("contact", ["id", "organizationId", "phone"]),
      conversation: table("conversation", ["id", "organizationId", "contactId"]),
      message: table("message", ["id", "organizationId", "conversationId"]),
      lead: table("lead", ["id", "organizationId", "contactId"]),
      kbEntry: table("kbEntry", ["id", "organizationId"]),
      agentTestCase: table("agentTestCase", ["id", "organizationId"]),
      agentTestRun: table("agentTestRun", ["id", "organizationId"]),
      pipelineStage: table("pipelineStage", ["id", "organizationId"]),
      agentProfile: table("agentProfile", ["id", "organizationId"]),
    },
    nextId: 0,
  };
});

vi.mock("drizzle-orm", () => ({
  and: (...conditions: Condition[]) => ({ op: "and", conditions }),
  eq: (column: Column, value: unknown) => ({ op: "eq", column, value }),
  inArray: (column: Column, values: unknown[]) => ({
    op: "in",
    column,
    values,
  }),
}));

vi.mock("@/lib/db", () => ({ schema: mocked.schema }));
vi.mock("@/lib/db/ids", () => ({
  newId: (prefix: string) => `${prefix}_seed_${++mocked.nextId}`,
}));

import { isDomainEmpty, seedDemo } from "@/server/seed/demo";

const DEMO_PHONES = Array.from(
  { length: 8 },
  (_, index) => `521561234000${index + 1}`
);
const TENANT_TABLES = new Set([
  "contact",
  "conversation",
  "message",
  "lead",
  "kbEntry",
  "agentTestCase",
  "agentTestRun",
  "pipelineStage",
  "agentProfile",
]);

function matches(row: Row, condition?: Condition): boolean {
  if (!condition) return true;
  if (condition.op === "and") {
    return condition.conditions.every((child) => matches(row, child));
  }
  if (condition.op === "eq") {
    return row[condition.column.name] === condition.value;
  }
  return condition.values.includes(row[condition.column.name]);
}

function hasTenantScope(
  condition: Condition | undefined,
  table: string,
  organizationId: string
): boolean {
  if (!condition) return false;
  if (condition.op === "and") {
    return condition.conditions.some((child) =>
      hasTenantScope(child, table, organizationId)
    );
  }
  return (
    condition.op === "eq" &&
    condition.column.table === table &&
    condition.column.name === "organizationId" &&
    condition.value === organizationId
  );
}

type AuditEntry = {
  kind: "select" | "delete" | "update" | "insert";
  table: string;
  condition?: Condition;
  values?: Row;
};

class SelectQuery implements PromiseLike<Row[]> {
  private table?: Table;
  private condition?: Condition;
  private rowLimit?: number;

  constructor(
    private readonly db: FakeDb,
    private readonly projection?: Record<string, Column>
  ) {}

  from(table: Table) {
    this.table = table;
    return this;
  }

  where(condition: Condition) {
    this.condition = condition;
    return this;
  }

  limit(value: number) {
    this.rowLimit = value;
    return this;
  }

  then<TResult1 = Row[], TResult2 = never>(
    onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    try {
      if (!this.table) throw new Error("select sin tabla");
      this.db.audit.push({
        kind: "select",
        table: this.table.__name,
        condition: this.condition,
      });
      let rows = this.db.rows(this.table.__name).filter((row) =>
        matches(row, this.condition)
      );
      if (this.rowLimit !== undefined) rows = rows.slice(0, this.rowLimit);
      const projection = this.projection;
      if (projection) {
        rows = rows.map((row) =>
          Object.fromEntries(
            Object.entries(projection).map(([key, column]) => [
              key,
              row[column.name],
            ])
          )
        );
      }
      return Promise.resolve(rows).then(onfulfilled, onrejected);
    } catch (error) {
      return Promise.reject(error).then(onfulfilled, onrejected);
    }
  }
}

class FakeDb {
  readonly audit: AuditEntry[] = [];

  constructor(readonly state: Record<string, Row[]>) {}

  rows(table: string): Row[] {
    return (this.state[table] ??= []);
  }

  select(projection?: Record<string, Column>) {
    return new SelectQuery(this, projection);
  }

  delete(table: Table) {
    return {
      where: async (condition: Condition) => {
        this.audit.push({ kind: "delete", table: table.__name, condition });
        this.state[table.__name] = this.rows(table.__name).filter(
          (row) => !matches(row, condition)
        );
      },
    };
  }

  insert(table: Table) {
    return {
      values: async (values: Row) => {
        this.audit.push({ kind: "insert", table: table.__name, values });
        this.rows(table.__name).push({ ...values });
      },
    };
  }

  update(table: Table) {
    return {
      set: (values: Row) => ({
        where: async (condition: Condition) => {
          this.audit.push({ kind: "update", table: table.__name, condition });
          for (const row of this.rows(table.__name)) {
            if (matches(row, condition)) Object.assign(row, values);
          }
        },
      }),
    };
  }
}

function initialState(): Record<string, Row[]> {
  const state: Record<string, Row[]> = {};
  for (const organizationId of ["org_a", "org_b"]) {
    state.pipelineStage ??= [];
    state.pipelineStage.push({
      id: `stage_${organizationId}`,
      organizationId,
      name: "Nuevo",
    });
    state.agentProfile ??= [];
    state.agentProfile.push({
      id: `profile_${organizationId}`,
      organizationId,
      name: `profile-${organizationId}`,
    });

    for (const [index, phone] of DEMO_PHONES.entries()) {
      const contactId = `old_contact_${organizationId}_${index}`;
      const conversationId = `old_conversation_${organizationId}_${index}`;
      state.contact ??= [];
      state.contact.push({ id: contactId, organizationId, phone });
      state.conversation ??= [];
      state.conversation.push({
        id: conversationId,
        organizationId,
        contactId,
      });
      state.message ??= [];
      state.message.push({
        id: `old_message_${organizationId}_${index}`,
        organizationId,
        conversationId,
      });
      state.lead ??= [];
      state.lead.push({
        id: `old_lead_${organizationId}_${index}`,
        organizationId,
        contactId,
      });
    }

    for (const table of ["kbEntry", "agentTestRun", "agentTestCase"]) {
      state[table] ??= [];
      state[table].push({ id: `old_${table}_${organizationId}`, organizationId });
    }
  }
  return state;
}

function tenantSnapshot(state: Record<string, Row[]>, organizationId: string) {
  return Object.fromEntries(
    Object.entries(state).map(([table, rows]) => [
      table,
      rows
        .filter((row) => row.organizationId === organizationId)
        .map((row) => ({ ...row }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    ])
  );
}

function tenantCount(
  state: Record<string, Row[]>,
  table: string,
  organizationId: string
) {
  return (state[table] ?? []).filter(
    (row) => row.organizationId === organizationId
  ).length;
}

function expectSeedShape(state: Record<string, Row[]>, organizationId: string) {
  expect(tenantCount(state, "contact", organizationId)).toBe(8);
  expect(tenantCount(state, "conversation", organizationId)).toBe(8);
  expect(tenantCount(state, "message", organizationId)).toBe(31);
  expect(tenantCount(state, "lead", organizationId)).toBe(8);
}

function expectAuditScoped(db: FakeDb, organizationId: string) {
  for (const entry of db.audit) {
    if (!TENANT_TABLES.has(entry.table)) continue;
    if (entry.kind === "insert") {
      expect(entry.values?.organizationId, `${entry.kind} ${entry.table}`).toBe(
        organizationId
      );
    } else {
      expect(
        hasTenantScope(entry.condition, entry.table, organizationId),
        `${entry.kind} ${entry.table} sin organizationId`
      ).toBe(true);
    }
  }
}

describe("seed demo: aislamiento tenant", () => {
  beforeEach(() => {
    mocked.nextId = 0;
  });

  it("ORG_B crea y limpia solo sus contactos, conversaciones, mensajes y leads", async () => {
    const state = initialState();
    const orgABefore = tenantSnapshot(state, "org_a");
    const db = new FakeDb(state);

    await seedDemo(db as never, "org_b");

    expect(tenantSnapshot(state, "org_a")).toEqual(orgABefore);
    expectSeedShape(state, "org_b");
    expectAuditScoped(db, "org_b");
  });

  it("ORG_A ejecuta seed sin tocar los fixtures privados de ORG_B", async () => {
    const state = initialState();
    const orgBBefore = tenantSnapshot(state, "org_b");
    const db = new FakeDb(state);

    await seedDemo(db as never, "org_a");

    expect(tenantSnapshot(state, "org_b")).toEqual(orgBBefore);
    expectSeedShape(state, "org_a");
    expectAuditScoped(db, "org_a");
  });

  it("repetir el seed conserva conteos y no cruza tenants", async () => {
    const state = initialState();
    const orgABefore = tenantSnapshot(state, "org_a");
    const db = new FakeDb(state);

    await seedDemo(db as never, "org_b");
    await seedDemo(db as never, "org_b");

    expect(tenantSnapshot(state, "org_a")).toEqual(orgABefore);
    expectSeedShape(state, "org_b");
    expectAuditScoped(db, "org_b");
  });

  it("isDomainEmpty consulta únicamente la organización solicitada", async () => {
    const state = initialState();
    const db = new FakeDb(state);

    await expect(isDomainEmpty(db as never, "org_b")).resolves.toBe(false);
    expectAuditScoped(db, "org_b");
  });
});
