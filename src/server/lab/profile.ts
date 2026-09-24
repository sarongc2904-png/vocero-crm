import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import {
  buildPersonas,
  DEFAULT_SCENARIO_SCRIPTS,
  SCENARIO_KEYS,
  type Persona,
  type ScenarioKey,
  type ScenarioScripts,
} from "@/server/lab/personas";

export type LabProfileData = {
  businessContext: string;
  enabledScenarios: ScenarioKey[];
  scenarioScripts: Record<ScenarioKey, string[]>;
};

function normalizeEnabled(value: unknown): ScenarioKey[] {
  if (!Array.isArray(value)) return [...SCENARIO_KEYS];
  const valid = value.filter((key): key is ScenarioKey =>
    typeof key === "string" && SCENARIO_KEYS.includes(key as ScenarioKey)
  );
  return valid.length > 0 ? valid : [...SCENARIO_KEYS];
}

function normalizeScripts(value: unknown): Record<ScenarioKey, string[]> {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};

  return Object.fromEntries(
    SCENARIO_KEYS.map((key) => {
      const lines = raw[key];
      if (!Array.isArray(lines)) return [key, DEFAULT_SCENARIO_SCRIPTS[key]];
      const cleaned = lines
        .filter((line): line is string => typeof line === "string")
        .map((line) => line.trim())
        .filter(Boolean);
      return [
        key,
        cleaned.length > 0 ? cleaned : DEFAULT_SCENARIO_SCRIPTS[key],
      ];
    })
  ) as Record<ScenarioKey, string[]>;
}

export async function getLabProfile(
  organizationId: string
): Promise<LabProfileData> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.labProfile)
    .where(eq(schema.labProfile.organizationId, organizationId))
    .limit(1);

  const row = rows[0];
  return {
    businessContext: row?.businessContext ?? "",
    enabledScenarios: normalizeEnabled(row?.enabledScenarios),
    scenarioScripts: normalizeScripts(row?.scenarioScripts),
  };
}

export async function getLabPersonas(
  organizationId: string
): Promise<Persona[]> {
  const profile = await getLabProfile(organizationId);
  return buildPersonas(profile);
}

export async function saveLabProfile(input: {
  organizationId: string;
  businessContext: string;
  enabledScenarios: ScenarioKey[];
  scenarioScripts: ScenarioScripts;
}): Promise<LabProfileData> {
  const db = getDb();
  const normalized = {
    businessContext: input.businessContext.trim(),
    enabledScenarios: normalizeEnabled(input.enabledScenarios),
    scenarioScripts: normalizeScripts(input.scenarioScripts),
  };

  const existing = await db
    .select({ id: schema.labProfile.id })
    .from(schema.labProfile)
    .where(eq(schema.labProfile.organizationId, input.organizationId))
    .limit(1);

  if (existing[0]) {
    await db
      .update(schema.labProfile)
      .set({
        businessContext: normalized.businessContext,
        enabledScenarios: normalized.enabledScenarios,
        scenarioScripts: normalized.scenarioScripts,
        updatedAt: new Date(),
      })
      .where(eq(schema.labProfile.organizationId, input.organizationId));
  } else {
    await db.insert(schema.labProfile).values({
      id: newId("labProfile"),
      organizationId: input.organizationId,
      businessContext: normalized.businessContext,
      enabledScenarios: normalized.enabledScenarios,
      scenarioScripts: normalized.scenarioScripts,
    });
  }

  return normalized;
}
