import { withOrgPermissions } from "@/lib/api";
import { getCommercialAccess } from "@/server/commercial/entitlement";

export const dynamic = "force-dynamic";

export const GET = withOrgPermissions(["settings.read"], async (session) => {
  return Response.json({
    subscription: await getCommercialAccess(session.organizationId),
  });
});
