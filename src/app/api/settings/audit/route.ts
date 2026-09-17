import { withOrgPermissions } from "@/lib/api";
import { listPrivilegedAudit } from "@/server/auth/audit";

export const dynamic = "force-dynamic";

export const GET = withOrgPermissions(["audit.read"], async (session, req: Request) => {
  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? "100");
  const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
  const rows = await listPrivilegedAudit(session.organizationId, limit);

  return Response.json({
    audit: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    })),
  });
});
