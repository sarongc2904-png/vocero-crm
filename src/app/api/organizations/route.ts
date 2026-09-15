import { asc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { z } from "zod";
import { parseBody, withAuth, withOrgRoles } from "@/lib/api";
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
    })
    .from(schema.member)
    .innerJoin(
      schema.organization,
      eq(schema.member.organizationId, schema.organization.id)
    )
    .where(eq(schema.member.userId, session.userId))
    .orderBy(asc(schema.member.createdAt), asc(schema.member.id));

  return Response.json({
    activeOrganizationId: session.organizationId,
    organizations: organizations.map((organization) => ({
      ...organization,
      active: organization.id === session.organizationId,
    })),
  });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const POST = withOrgRoles(["owner"], async (session, req: Request) => {
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
