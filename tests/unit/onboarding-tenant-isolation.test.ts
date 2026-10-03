import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as string[][] }));

vi.mock("@/lib/db", () => ({
  schema: { onboardingProgress: { organizationId: "organizationId" } },
  getSql: () => (_strings: TemplateStringsArray, ...values: unknown[]) => {
    h.calls.push(values.map(String));
    const organizationId = String(values[0]);
    return Promise.resolve([
      {
        business: true,
        timezone: organizationId === "org_A",
        whatsapp: true,
        calendar: false,
        agent: true,
        test: true,
        activation: false,
      },
    ]);
  },
  getDb: () => ({
    insert: () => ({
      values: () => ({ onConflictDoUpdate: () => Promise.resolve() }),
    }),
  }),
}));

vi.mock("@/server/commercial/schedule-coherence", () => ({
  getScheduleCoherence: async (organizationId: string) => ({
    status: "unverifiable",
    message: organizationId,
    differences: [],
    shortBookingWindow: false,
    maxDaysAhead: null,
  }),
}));

describe("aislamiento del onboarding", () => {
  beforeEach(() => {
    h.calls.length = 0;
  });

  it("agenda y progreso se calculan solo con el organizationId solicitado", async () => {
    const { getOnboardingState } = await import("@/server/commercial/onboarding");
    const a = await getOnboardingState("org_A");
    const b = await getOnboardingState("org_B");

    expect(a.steps.find((step) => step.id === "timezone")?.complete).toBe(true);
    expect(b.steps.find((step) => step.id === "timezone")?.complete).toBe(false);
    expect(a.scheduleCoherence.message).toBe("org_A");
    expect(b.scheduleCoherence.message).toBe("org_B");
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]?.every((value) => value === "org_A")).toBe(true);
    expect(h.calls[1]?.every((value) => value === "org_B")).toBe(true);
  });
});
