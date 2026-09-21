import { asc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getAuth } from "@/lib/auth";
import { getDb, schema } from "@/lib/db";
import { createOrganizationForOwner } from "@/server/auth/organizations";

export const dynamic = "force-dynamic";

export const GET = withAuth(async (session) => {
  const organizations = await getDb()
    .select({
      id: schema.organization.id,
      name: schema.organization.name,
      slug: schema.organization.slug,
      role: schema.member.role,
      createdAt: schema.organization.createdAt,
      commercialStatus: schema.organizationEntitlement.status,
      trialEndsAt: schema.organizationEntitlement.trialEndsAt,
      activatedAt: schema.onboardingProgress.activatedAt,
    })
    .from(schema.member)
    .innerJoin(
      schema.organization,
      eq(schema.member.organizationId, schema.organization.id)
    )
    .leftJoin(
      schema.organizationEntitlement,
      eq(schema.organizationEntitlement.organizationId, schema.organization.id)
    )
    .leftJoin(
      schema.onboardingProgress,
      eq(schema.onboardingProgress.organizationId, schema.organization.id)
    )
    .where(eq(schema.member.userId, session.userId))
    .orderBy(asc(schema.member.createdAt), asc(schema.member.id));

  const now = Date.now();
  const visibleOrganizations = session.isSuperadmin
    ? organizations
    : organizations.filter((organization) => {
        if (organization.commercialStatus === "active") return true;
        if (organization.commercialStatus !== "trial") return false;
        return Boolean(
          organization.trialEndsAt &&
            organization.trialEndsAt.getTime() > now
        );
      });

  return Response.json({
    activeOrganizationId: session.organizationId,
    organizations: visibleOrganizations.map((organization) => ({
      ...organization,
      trialEndsAt: organization.trialEndsAt?.toISOString() ?? null,
      operationalStatus: organization.activatedAt ? "listo_para_operar" : "configurando",
      active: organization.id === session.organizationId,
    })),
  });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const POST = withAuth(async (session, req: Request) => {
  if (!session.isSuperadmin) {
    return apiError(
      403,
      "forbidden",
      "Las nuevas organizaciones se crean desde administración"
    );
  }

  const body = await parseBody(req, createSchema);
  if (!body.ok) return body.response;

  const organization = await createOrganizationForOwner(
    session.userId,
    body.data.name
  );
  await getAuth().api.setActiveOrganization({
    headers: await headers(),
    body: { organizationId: organization.id },
  });
  return Response.json({ organization }, { status: 201 });
});
