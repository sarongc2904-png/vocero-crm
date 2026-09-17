import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getAuth } from "@/lib/auth";
import { getDb, schema } from "@/lib/db";
import { auditPrivilegedAction } from "@/server/auth/audit";
import {
  organizationExists,
  resolveActiveMembership,
} from "@/server/auth/organizations";
import { isMemberSuspended } from "@/server/auth/suspension";

export const dynamic = "force-dynamic";

const activeSchema = z.object({
  organizationId: z.string().trim().min(1),
});

const setActive = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, activeSchema);
  if (!body.ok) return body.response;

  if (session.isSuperadmin) {
    if (!(await organizationExists(body.data.organizationId))) {
      return apiError(404, "organization_not_found", "Organización no encontrada");
    }

    // Better Auth exige membership para setActiveOrganization. El superadmin
    // deliberadamente NO es member de todos los tenants, así que sólo para
    // esta capacidad de plataforma actualizamos SU sesión autenticada.
    await getDb()
      .update(schema.session)
      .set({ activeOrganizationId: body.data.organizationId })
      .where(eq(schema.session.id, session.sessionId));

    await auditPrivilegedAction(
      { ...session, organizationId: body.data.organizationId },
      {
        action: "tenant.switch",
        targetType: "organization",
        targetId: body.data.organizationId,
        metadata: { previousOrganizationId: session.organizationId },
      }
    );

    return Response.json({
      activeOrganizationId: body.data.organizationId,
      role: "owner",
      mode: "superadmin",
    });
  }

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
  if (await isMemberSuspended(body.data.organizationId, session.userId)) {
    return apiError(
      403,
      "organization_suspended",
      "Tu acceso a la organización solicitada está suspendido"
    );
  }

  await getAuth().api.setActiveOrganization({
    headers: await headers(),
    body: { organizationId: membership.organizationId },
  });
  return Response.json({
    activeOrganizationId: membership.organizationId,
    role: membership.role,
    mode: "member",
  });
});

export const POST = setActive;
export const PUT = setActive;
