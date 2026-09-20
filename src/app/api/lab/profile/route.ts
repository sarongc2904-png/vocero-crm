import { z } from "zod";
import { parseBody, withOrgRoles } from "@/lib/api";
import { getLabProfile, saveLabProfile } from "@/server/lab/profile";
import { SCENARIO_KEYS } from "@/server/lab/personas";

export const dynamic = "force-dynamic";

const scenarioKey = z.enum(SCENARIO_KEYS);

const profileSchema = z.object({
  businessContext: z.string().max(8000).default(""),
  enabledScenarios: z.array(scenarioKey).min(1).max(SCENARIO_KEYS.length),
  scenarioScripts: z.record(
    scenarioKey,
    z.array(z.string().trim().min(1).max(1000)).min(1).max(8)
  ),
});

export const GET = withOrgRoles(["owner", "admin"], async (session) => {
  return Response.json({
    profile: await getLabProfile(session.organizationId),
  });
});

export const PUT = withOrgRoles(
  ["owner", "admin"],
  async (session, req: Request) => {
    const body = await parseBody(req, profileSchema);
    if (!body.ok) return body.response;

    const profile = await saveLabProfile({
      organizationId: session.organizationId,
      ...body.data,
    });
    return Response.json({ profile });
  }
);
