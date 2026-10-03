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
          where: (condition: { column: string; value: unknown }) => {
            const limit = (amount: number) =>
              Promise.resolve(
                fake.stored[table.table]
                  .filter((row) => row[condition.column] === condition.value)
                  .slice(0, amount)
              );
            return {
              limit,
              orderBy: () => ({ limit }),
            };
          },
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

import {
  createOrganizationForOwner,
  createSelfServeOrganizationForOwner,
} from "@/server/auth/organizations";

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

  it("dos altas self-serve consecutivas con el mismo nombre reciben slugs únicos", async () => {
    const first = await createSelfServeOrganizationForOwner("user_1", "Mi Negocio", {
      publicSignupOpen: true,
    });
    const second = await createSelfServeOrganizationForOwner("user_2", "Mi Negocio", {
      publicSignupOpen: true,
    });

    expect(first.slug).toBe("mi-negocio");
    expect(second.slug).toBe("mi-negocio-2");
    expect(fake.stored.organization).toHaveLength(2);
  });

  it("doble clic o reintento devuelve la misma organización del usuario", async () => {
    const first = await createSelfServeOrganizationForOwner("user_1", "Negocio Uno", {
      publicSignupOpen: true,
    });
    const retry = await createSelfServeOrganizationForOwner("user_1", "Otro nombre", {
      publicSignupOpen: true,
    });

    expect(retry.id).toBe(first.id);
    expect(retry.created).toBe(false);
    expect(fake.stored.organization).toHaveLength(1);
    expect(fake.stored.member).toHaveLength(1);
  });

  it("el bootstrap no crea calendar_settings", async () => {
    await createSelfServeOrganizationForOwner("user_1", "Negocio Uno", {
      publicSignupOpen: true,
    });
    expect(JSON.stringify(fake.stored)).not.toContain("calendarSettings");
  });

  it("rechaza nombres de negocio vacíos o mayores a 120 caracteres", async () => {
    await expect(
      createSelfServeOrganizationForOwner("user_1", " ", {
        publicSignupOpen: true,
      })
    ).rejects.toThrow(/entre 2 y 120/);
    await expect(
      createSelfServeOrganizationForOwner("user_1", "x".repeat(121), {
        publicSignupOpen: true,
      })
    ).rejects.toThrow(/entre 2 y 120/);
  });
});
