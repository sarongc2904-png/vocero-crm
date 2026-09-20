import { withOrgPermissionsOptions } from "@/lib/api";
import { getCommercialAccess } from "@/server/commercial/entitlement";

export const dynamic = "force-dynamic";

export const GET = withOrgPermissionsOptions(
  { allowBlockedCommercialAccess: true },
  ["settings.read"],
  async (session) => {
    return Response.json({
      subscription: await getCommercialAccess(session.organizationId),
    });
  }
);
