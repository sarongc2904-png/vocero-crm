import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

type MembershipRow = {
  userId: string;
  organizationId: string;
  role: string;
  createdAt: Date;
  id: string;
};

const memberships: MembershipRow[] = [
  {
    userId: "user_1",
    organizationId: "org_a",
    role: "owner",
    createdAt: new Date("2026-01-01"),
    id: "member_1a",
  },
  {
    userId: "user_1",
    organizationId: "org_b",
    role: "admin",
    createdAt: new Date("2026-01-02"),
    id: "member_1b",
  },
  {
    userId: "user_2",
    organizationId: "org_b",
    role: "agent",
    createdAt: new Date("2026-01-03"),
    id: "member_2b",
  },
];

vi.mock("drizzle-orm", () => ({
  asc: (column: string) => column,
  eq: (column: string, value: unknown) => ({ column, value }),
  sql: () => null,
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: (condition: { column: string; value: unknown }) => ({
          orderBy: () =>
            Promise.resolve(
              memberships
                .filter((row) => row[condition.column as keyof MembershipRow] === condition.value)
                .map(({ organizationId, role }) => ({ organizationId, role }))
            ),
        }),
      }),
    }),
  }),
  schema: {
    member: {
      id: "id",
      userId: "userId",
      organizationId: "organizationId",
      role: "role",
      createdAt: "createdAt",
    },
  },
}));

import { hasOrganizationRole } from "@/lib/auth/roles";
import { resolveActiveMembership } from "@/server/auth/organizations";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

describe("Fase 2A: organización activa y switching", () => {
  it("USER_1 usa ORG_B cuando activeOrganizationId apunta a su membership", async () => {
    await expect(resolveActiveMembership("user_1", "org_b")).resolves.toEqual({
      organizationId: "org_b",
      role: "admin",
      usedFallback: false,
    });
  });

  it("una org ajena se rechaza y el resolver conserva una membership válida", async () => {
    await expect(resolveActiveMembership("user_2", "org_a")).resolves.toEqual({
      organizationId: "org_b",
      role: "agent",
      usedFallback: true,
    });
  });

  it("sin memberships no inventa una organización", async () => {
    await expect(resolveActiveMembership("user_3", "org_a")).resolves.toBeNull();
  });

  it("la ruta de switching valida membership antes de Better Auth", () => {
    const route = source("src/app/api/organizations/active/route.ts");
    expect(route).toContain("resolveActiveMembership");
    expect(route).toContain("membership.organizationId !== body.data.organizationId");
    expect(route).toContain("setActiveOrganization");
    expect(route).toContain("organization_forbidden");
  });
});

describe("Fase 2A: roles y RBAC centralizado", () => {
  it("aplica la matriz owner/admin/agent", () => {
    expect(hasOrganizationRole("owner", ["owner"])).toBe(true);
    expect(hasOrganizationRole("admin", ["owner", "admin"])).toBe(true);
    expect(hasOrganizationRole("agent", ["owner", "admin"])).toBe(false);
    expect(hasOrganizationRole("member", ["agent"])).toBe(true);
  });

  it("todas las superficies sensibles usan un gate reutilizable de autorización", () => {
    const sensitive = [
      "src/app/api/settings/team/route.ts",
      "src/app/api/settings/bot-api-key/route.ts",
      "src/app/api/settings/google/route.ts",
      "src/app/api/settings/whatsapp/route.ts",
      "src/app/api/settings/instagram/route.ts",
      "src/app/api/settings/messenger/route.ts",
      "src/app/api/settings/webhook/route.ts",
      "src/app/api/settings/branding/route.ts",
      "src/app/api/settings/capi/route.ts",
      "src/app/api/settings/zoom/route.ts",
    ];
    for (const path of sensitive) {
      expect(source(path), path).toMatch(/withOrg(?:Roles|Permissions)/);
    }
  });

  it("Better Auth no deja una ruta alterna para crear orgs o gestionar equipo", () => {
    const auth = source("src/lib/auth/index.ts");
    expect(auth).toContain("allowUserToCreateOrganization: false");
    expect(auth).toContain('"/organization/create"');
    expect(auth).toContain('"/organization/remove-member"');
    expect(auth).toContain('"/organization/update-member-role"');
    expect(auth).toContain("BLOCKED_ORGANIZATION_MUTATIONS.has(ctx.path)");
  });

  it("la migración convierte member antes de imponer el constraint", () => {
    const migration = source("drizzle/0016_phase2a_roles.sql");
    expect(migration.indexOf("UPDATE \"member\" SET \"role\" = 'agent'"))
      .toBeLessThan(migration.indexOf("member_role_check"));
    expect(migration).toContain("'owner', 'admin', 'agent'");
  });
});

describe("Fase 2A: aislamiento cross-tenant", () => {
  it.each([
    ["contacts", "src/app/api/contacts/route.ts", "session.organizationId"],
    ["conversations", "src/server/inbox/queries.ts", "conversation.organizationId"],
    ["messages", "src/server/inbox/queries.ts", "message.organizationId"],
    ["leads", "src/app/api/pipeline/board/route.ts", "lead.organizationId"],
    ["bookings", "src/server/agenda/queries.ts", "booking.organizationId"],
    ["settings", "src/app/api/settings/google/route.ts", "session.organizationId"],
    ["media", "src/app/api/media/[assetId]/route.ts", "session.organizationId"],
    ["bot api", "src/server/bot/auth.ts", "resolveOrgByApiKey"],
  ])("%s conserva el tenant en reads/writes", (_name, path, guard) => {
    expect(source(path)).toContain(guard);
  });

  it("los joins principales comparan organization_id en ambos lados", () => {
    const sources = [
      source("src/app/api/pipeline/board/route.ts"),
      source("src/server/inbox/queries.ts"),
      source("src/server/agenda/queries.ts"),
      source("src/app/api/bot/context/route.ts"),
    ];
    for (const value of sources) expect(value).toMatch(/organizationId[\s\S]*organizationId/);
  });

  it("media ajena responde 404 y nunca revela existencia", () => {
    const route = source("src/app/api/media/[assetId]/route.ts");
    expect(route).toContain("scoped(");
    expect(route).toContain('apiError(404, "not_found"');
  });

  it("WhatsApp enruta phone_number_id a la organización de sus credenciales", () => {
    const ingest = source("src/server/inbox/ingest.ts");
    const credentials = source("src/server/whatsapp/credentials.ts");
    expect(ingest).toContain("getCredentialsByPhoneNumberId(phoneNumberId)");
    expect(ingest).toContain("credentials.organizationId");
    expect(credentials).toContain("metaCredentials.phoneNumberId");
  });

  it("branding público devuelve DEFAULT_BRANDING sin consultar la primera org", () => {
    const branding = source("src/server/branding.ts");
    expect(branding).toContain("if (!organizationId)");
    expect(branding).toContain("organizationId: null, branding: DEFAULT_BRANDING");
    expect(branding).not.toContain("la única organización de la instancia");
    for (const path of [
      "src/app/layout.tsx",
      "src/app/(auth)/layout.tsx",
      "src/app/api/branding/favicon/route.ts",
    ]) {
      const requestSurface = source(path);
      expect(requestSurface, path).toContain("getSessionOrNull");
      expect(requestSurface, path).toContain("session?.organizationId");
    }
  });
});
