import { beforeEach, describe, expect, it, vi } from "vitest";

type Table =
  | "organization"
  | "member"
  | "pipelineStage"
  | "agentProfile"
  | "organizationEntitlement"
  | "onboardingProgress"
  | "commercialPlan";
type Row = Record<string, unknown>;

const fake = vi.hoisted(() => ({
  stored: {
    organization: [] as Row[],
    member: [] as Row[],
    pipelineStage: [] as Row[],
    agentProfile: [] as Row[],
    organizationEntitlement: [] as Row[],
    onboardingProgress: [] as Row[],
    commercialPlan: [] as Row[],
  } satisfies Record<Table, Row[]>,
  schema: {
    organization: { table: "organization" as const, id: "id", slug: "slug" },
    member: {
      table: "member" as const,
      id: "id",
      userId: "userId",
      organizationId: "organizationId",
      role: "role",
      createdAt: "createdAt",
    },
    pipelineStage: { table: "pipelineStage" as const },
    agentProfile: { table: "agentProfile" as const },
    organizationEntitlement: { table: "organizationEntitlement" as const },
    onboardingProgress: { table: "onboardingProgress" as const },
    commercialPlan: {
      table: "commercialPlan" as const,
      id: "id",
      trialDays: "trialDays",
    },
  },
}));

vi.mock("drizzle-orm", () => ({
  asc: (column: string) => column,
  eq: (column: string, value: unknown) => ({ column, value }),
  sql: () => null,
}));

vi.mock("@/lib/db", () => ({
  schema: fake.schema,
  getDb: () => {
    const tx = {
      execute: () => Promise.resolve(),
      select: () => ({
        from: (table: { table: Table }) => ({
          where: (condition: { column: string; value: unknown }) => ({
            limit: (limit: number) =>
              Promise.resolve(
                fake.stored[table.table]
                  .filter((row) => row[condition.column] === condition.value)
                  .slice(0, limit)
              ),
          }),
        }),
      }),
      insert: (table: { table: Table }) => ({
        values: (value: Row | Row[]) => {
          fake.stored[table.table].push(...(Array.isArray(value) ? value : [value]));
          return Promise.resolve();
        },
      }),
    };
    return { transaction: (callback: (value: typeof tx) => unknown) => callback(tx) };
  },
}));

import { createOrganizationForOwner } from "@/server/auth/organizations";

beforeEach(() => {
  for (const rows of Object.values(fake.stored)) rows.length = 0;
  fake.stored.commercialPlan.push({
    id: "plan_conecta_mx",
    trialDays: 3,
  });
});

describe("bootstrap multi-organización", () => {
  it("crea dos tenants completos, con slugs únicos y owner por organización", async () => {
    const first = await createOrganizationForOwner("user_1", "Mi Negocio");
    const second = await createOrganizationForOwner("user_1", "Mi Negocio");

    expect(first.slug).toBe("mi-negocio");
    expect(second.slug).toBe("mi-negocio-2");
    expect(new Set(fake.stored.organization.map((row) => row.id)).size).toBe(2);
    expect(fake.stored.member).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ organizationId: first.id, userId: "user_1", role: "owner" }),
        expect.objectContaining({ organizationId: second.id, userId: "user_1", role: "owner" }),
      ])
    );
    expect(fake.stored.pipelineStage).toHaveLength(10);
    expect(fake.stored.agentProfile).toHaveLength(2);
    expect(fake.stored.organizationEntitlement).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ organizationId: first.id, status: "trial" }),
        expect.objectContaining({ organizationId: second.id, status: "trial" }),
      ])
    );
    expect(fake.stored.onboardingProgress).toHaveLength(2);
  });

  it("produce un slug seguro aun con un nombre sin caracteres ASCII", async () => {
    const created = await createOrganizationForOwner("user_1", "  東京  ");
    expect(created.slug).toBe("organizacion");
    expect(created.slug).toMatch(/^[a-z0-9-]+$/);
  });
});
