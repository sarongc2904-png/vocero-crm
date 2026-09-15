import { headers } from "next/headers";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getAuth } from "@/lib/auth";
import { resolveActiveMembership } from "@/server/auth/organizations";

export const dynamic = "force-dynamic";

const activeSchema = z.object({
  organizationId: z.string().trim().min(1),
});

const setActive = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, activeSchema);
  if (!body.ok) return body.response;

  const membership = await resolveActiveMembership(
    session.userId,
    body.data.organizationId
  );
  if (!membership || membership.organizationId !== body.data.organizationId) {
    return apiError(
      403,
      "organization_forbidden",
      "No perteneces a la organización solicitada"
    );
  }

  await getAuth().api.setActiveOrganization({
    headers: await headers(),
    body: { organizationId: membership.organizationId },
  });
  return Response.json({
    activeOrganizationId: membership.organizationId,
    role: membership.role,
  });
});

export const POST = setActive;
export const PUT = setActive;
