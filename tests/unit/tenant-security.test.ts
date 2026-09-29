import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SEC-V1 / SEC-V2 / SEC-V4 / SEC-V5 / SEC-V3 / INB-4 — aislamiento de escritura
 * y permisos.
 *
 * Las claves foráneas de este esquema son de una sola columna (globales), así
 * que la pertenencia de una referencia que llega del cliente NO la puede
 * garantizar Postgres. Estos tests fijan que cada camino de escritura la
 * comprueba antes de tocar la base, y que un id ajeno no produce ninguna fila.
 *
 * Los tests 10 y 11 del paquete (constraint de Postgres con organization_id y
 * dos tenants con profesional/rango equivalentes) viven en
 * `scripts/postgres-release-gate.mjs`, porque necesitan una base real.
 */

const h = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  inserts: [] as { table: unknown; values: Record<string, unknown> }[],
  auditWrites: [] as unknown[][],
}));

function thenableChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of [
    "from",
    "where",
    "orderBy",
    "limit",
    "innerJoin",
    "leftJoin",
    "groupBy",
    "offset",
  ]) {
    chain[m] = () => chain;
  }
  (chain as { then: unknown }).then = (res: (value: unknown) => void) =>
    Promise.resolve(rows).then(res);
  return chain;
}

const fakeDb = {
  select: () => thenableChain(h.selectQueue.shift() ?? []),
  insert: (table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      h.inserts.push({ table, values });
      const chain: Record<string, unknown> = {};
      chain.onConflictDoNothing = () => chain;
      chain.onConflictDoUpdate = () => chain;
      chain.returning = () => Promise.resolve([{ ...values }]);
      (chain as { then: unknown }).then = (res: (value: unknown) => void) =>
        Promise.resolve([{ ...values }]).then(res);
      return chain;
    },
  }),
  update: () => ({
    set: () => ({
      where: () => ({
        returning: () => Promise.resolve([{}]),
        then: (res: (value: unknown) => void) => Promise.resolve([{}]).then(res),
      }),
    }),
  }),
  transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb),
};

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  const sql = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    h.auditWrites.push(values);
    return Promise.resolve([]);
  };
  return { ...original, getDb: () => fakeDb, getSql: () => sql };
});

const settings = {
  weeklyHours: {},
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 0,
  maxDaysAhead: 14,
  timezone: "UTC",
  connector: "google" as const,
  meetingLink: null,
  videoCall: true,
};

vi.mock("@/server/agenda/settings", () => ({ getSettings: async () => settings }));
vi.mock("@/server/events/bus", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/events/bus")>();
  return { ...original, publish: () => {} };
});
vi.mock("@/server/leads/stage-history", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/server/leads/stage-history")
  >();
  return { ...original, recordLeadCreated: async () => {} };
});

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

beforeEach(() => {
  h.selectQueue.length = 0;
  h.inserts.length = 0;
  h.auditWrites.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
// 1-2 · Helper de pertenencia
// ─────────────────────────────────────────────────────────────────────────────

describe("requireTenantEntity — pertenencia obligatoria (SEC-V1/V2/V4)", () => {
  it("acepta una entidad de la MISMA organización", async () => {
    const {
      requireTenantStage,
      requireTenantProfessional,
      requireTenantContact,
      requireTenantService,
    } = await import("@/server/tenant/ownership");

    h.selectQueue.push([{ id: "stg_own" }]);
    await expect(requireTenantStage("org_a", "stg_own")).resolves.toBe("stg_own");

    h.selectQueue.push([{ id: "pro_own" }]);
    await expect(
      requireTenantProfessional("org_a", "pro_own")
    ).resolves.toBe("pro_own");

    h.selectQueue.push([{ id: "ct_own" }]);
    await expect(requireTenantContact("org_a", "ct_own")).resolves.toBe("ct_own");

    h.selectQueue.push([{ id: "svc_own" }]);
    await expect(requireTenantService("org_a", "svc_own")).resolves.toBe("svc_own");
  });

  it("rechaza una entidad de OTRA organización (o inexistente) con código not_found", async () => {
    const {
      requireTenantStage,
      requireTenantProfessional,
      requireTenantContact,
      TenantReferenceError,
    } = await import("@/server/tenant/ownership");

    for (const call of [
      () => requireTenantStage("org_a", "stg_ajena"),
      () => requireTenantProfessional("org_a", "pro_ajeno"),
      () => requireTenantContact("org_a", "ct_ajeno"),
    ]) {
      h.selectQueue.push([]);
      await expect(call()).rejects.toBeInstanceOf(TenantReferenceError);
      await expect(call()).rejects.toMatchObject({ code: "not_found" });
    }
  });

  it("un organizationId vacío no degrada a consulta global", async () => {
    const { requireTenantStage } = await import("@/server/tenant/ownership");

    await expect(requireTenantStage("", "stg_x")).rejects.toThrow(
      /organizationId vacío/
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1-2 · SEC-V1 — POST /api/contacts con stageId
// ─────────────────────────────────────────────────────────────────────────────

describe("SEC-V1 — stageId de otro tenant no crea lead", () => {
  it("stageId del mismo tenant → el lead se crea en esa etapa", async () => {
    const { createLeadForContact } = await import("@/server/inbox/lead-activity");

    h.selectQueue.push([{ id: "stg_own" }]); // requireTenantStage
    h.selectQueue.push([{ max: -1 }]); // posición máxima de la etapa

    const lead = await createLeadForContact({
      organizationId: "org_a",
      contactId: "ct_own",
      stageId: "stg_own",
    });

    expect(lead?.stageId).toBe("stg_own");
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0]!.values.stageId).toBe("stg_own");
  });

  it("stageId de otro tenant → rechaza y NO escribe lead", async () => {
    const { createLeadForContact } = await import("@/server/inbox/lead-activity");
    const { TenantReferenceError } = await import("@/server/tenant/ownership");

    h.selectQueue.push([]); // la etapa no existe en esta organización

    await expect(
      createLeadForContact({
        organizationId: "org_a",
        contactId: "ct_own",
        stageId: "stg_de_otro_tenant",
      })
    ).rejects.toBeInstanceOf(TenantReferenceError);

    expect(h.inserts).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3-4 · SEC-V2 — bloqueo con professionalId
// ─────────────────────────────────────────────────────────────────────────────

describe("SEC-V2 — professionalId de otro tenant no crea bloqueo", () => {
  it("profesional del mismo tenant → el bloqueo se crea", async () => {
    const { createBlock } = await import("@/server/agenda/service");

    h.selectQueue.push([{ id: "pro_own" }]);

    const block = await createBlock({
      organizationId: "org_a",
      startUtc: "2031-01-15T16:00:00.000Z",
      durationMinutes: 60,
      professionalId: "pro_own",
    });

    expect(block.professionalId).toBe("pro_own");
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0]!.values.professionalId).toBe("pro_own");
  });

  it("profesional de otro tenant → 404 (not_found) y cero escritura", async () => {
    const { createBlock, BookingError } = await import("@/server/agenda/service");

    h.selectQueue.push([]); // el profesional no es de esta organización

    await expect(
      createBlock({
        organizationId: "org_a",
        startUtc: "2031-01-15T16:00:00.000Z",
        durationMinutes: 60,
        professionalId: "pro_de_otro_tenant",
      })
    ).rejects.toMatchObject({ code: "not_found" });

    await expect(
      createBlock({
        organizationId: "org_a",
        startUtc: "2031-01-15T16:00:00.000Z",
        durationMinutes: 60,
        professionalId: "pro_de_otro_tenant",
      })
    ).rejects.toBeInstanceOf(BookingError);

    expect(h.inserts).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · SEC-V4 — contactId de otro tenant
// ─────────────────────────────────────────────────────────────────────────────

describe("SEC-V4 — contactId de otro tenant no crea cita", () => {
  it("sin conversationId, un contacto ajeno se rechaza y no se escribe cita", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");

    h.selectQueue.push([]); // requireTenantContact: el contacto es de otro tenant

    await expect(
      createSessionBooking({
        organizationId: "org_a",
        contactId: "ct_de_otro_tenant",
        startUtc: "2031-01-15T16:00:00.000Z",
        source: "manual",
        requireOffer: false,
      })
    ).rejects.toMatchObject({ code: "not_found" });

    expect(h.inserts).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 · SEC-V5 — permisos de PATCH /api/bookings/[id]
// ─────────────────────────────────────────────────────────────────────────────

describe("SEC-V5 — permisos por acción en PATCH de cita", () => {
  it("cada acción exige un permiso de citas ya existente", async () => {
    const { BOOKING_PATCH_PERMISSION } = await import("@/server/agenda/http");

    expect(Object.keys(BOOKING_PATCH_PERMISSION).sort()).toEqual([
      "cancel",
      "reschedule",
      "retry_link",
      "status",
    ]);
    for (const permission of Object.values(BOOKING_PATCH_PERMISSION)) {
      expect(permission.startsWith("appointments.")).toBe(true);
    }
    expect(BOOKING_PATCH_PERMISSION.cancel).toBe("appointments.cancel");
    expect(BOOKING_PATCH_PERMISSION.reschedule).toBe("appointments.reschedule");
  });

  it("la ruta deja de usar withAuth a secas y evalúa el permiso", () => {
    const route = source("src/app/api/bookings/[id]/route.ts");

    expect(route).toContain("BOOKING_PATCH_PERMISSION[body.data.action]");
    expect(route).toContain("hasOrganizationPermission(");
    expect(route).toContain('apiError(\n      403,');
  });

  it("el gate deniega cuando falta el permiso (mecanismo que usa la ruta)", async () => {
    const { hasOrganizationPermission } = await import("@/lib/auth/permissions");

    // Un agent no puede tocar la configuración del negocio...
    expect(hasOrganizationPermission("agent", "settings.update")).toBe(false);
    expect(hasOrganizationPermission("agent", "audit.read")).toBe(false);
    // ...pero sí responder: por eso INB-4 no cambia el comportamiento de hoy.
    expect(hasOrganizationPermission("agent", "conversations.reply")).toBe(true);
    // El superadmin atraviesa el gate.
    expect(
      hasOrganizationPermission("agent", "settings.update", { isSuperadmin: true })
    ).toBe(true);
  });

  it("los tres roles actuales conservan todos los permisos de citas", async () => {
    const { hasOrganizationPermission, ORGANIZATION_PERMISSIONS } = await import(
      "@/lib/auth/permissions"
    );

    const appointmentPermissions = ORGANIZATION_PERMISSIONS.filter((permission) =>
      permission.startsWith("appointments.")
    );
    for (const role of ["owner", "admin", "agent"] as const) {
      for (const permission of appointmentPermissions) {
        expect(hasOrganizationPermission(role, permission)).toBe(true);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7-8 · INB-4 — media y template exigen conversations.reply
// ─────────────────────────────────────────────────────────────────────────────

describe("INB-4 — los tres caminos de envío exigen conversations.reply", () => {
  it("texto, adjunto y plantilla comparten el mismo gate", () => {
    const paths = [
      "src/app/api/conversations/[id]/messages/route.ts",
      "src/app/api/conversations/[id]/messages/media/route.ts",
      "src/app/api/conversations/[id]/messages/template/route.ts",
    ];

    for (const path of paths) {
      const route = source(path);
      expect(route).toContain('"conversations.reply"');
      expect(route).toContain("withOrgPermissions");
      // Ninguno puede volver al gate de solo sesión: importar `withAuth` sería
      // la regresión que este test vigila (el comentario del archivo sí lo
      // menciona, por eso se mira el import y no el texto suelto).
      expect(route).not.toMatch(/import\s*\{[^}]*\bwithAuth\b[^}]*\}/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9 · SEC-V3 — firma del webhook
// ─────────────────────────────────────────────────────────────────────────────

describe("SEC-V3 — firma del webhook de WhatsApp", () => {
  const secret = "app-secret-de-prueba";
  const body = JSON.stringify({ object: "whatsapp_business_account" });

  it("firma inválida o ausente con secreto → rechaza", async () => {
    const { isValidSignature } = await import("@/server/inbox/webhook");

    expect(isValidSignature(body, "sha256=basura", secret)).toBe(false);
    expect(isValidSignature(body, null, secret)).toBe(false);
    expect(
      isValidSignature(body, "sha256=basura", secret, { requireSecret: true })
    ).toBe(false);
  });

  it("sin secreto: permisivo en local, RECHAZA en producción", async () => {
    const { isValidSignature } = await import("@/server/inbox/webhook");

    // Comportamiento histórico (local/CI): la capa queda desactivada.
    expect(isValidSignature(body, null, undefined)).toBe(true);
    // SEC-V3: en producción la capa es obligatoria.
    expect(isValidSignature(body, null, undefined, { requireSecret: true })).toBe(
      false
    );
    expect(
      isValidSignature(body, "sha256=basura", undefined, { requireSecret: true })
    ).toBe(false);
  });

  it("la ruta del webhook exige la firma en producción", () => {
    const route = source("src/app/api/webhooks/wa/[webhookToken]/route.ts");

    expect(route).toContain('requireSecret: env.NODE_ENV === "production"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12-13 · Auditoría
// ─────────────────────────────────────────────────────────────────────────────

const AUDITED_ROUTES = [
  "src/app/api/organizations/route.ts",
  "src/app/api/settings/bot-api-key/route.ts",
  "src/app/api/settings/whatsapp/route.ts",
  "src/app/api/settings/whatsapp/embedded-signup/route.ts",
  "src/app/api/settings/instagram/route.ts",
  "src/app/api/settings/messenger/route.ts",
  "src/app/api/settings/capi/route.ts",
  "src/app/api/settings/google/route.ts",
  "src/app/api/settings/zoom/route.ts",
  "src/app/api/settings/branding/route.ts",
  "src/app/api/agent/profile/route.ts",
];

function auditBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /auditPrivilegedAction\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const rest = text.slice(match.index, match.index + 900);
    const end = rest.indexOf("});");
    blocks.push(end === -1 ? rest : rest.slice(0, end));
  }
  return blocks;
}

describe("SEC-V6/V7 — auditoría de acciones sensibles", () => {
  it("se registran actor, organización, acción y destino", async () => {
    const { auditPrivilegedAction } = await import("@/server/auth/audit");

    await auditPrivilegedAction(
      {
        organizationId: "org_a",
        userId: "user_1",
        role: "admin",
        isSuperadmin: false,
      } as never,
      {
        action: "organization.create",
        targetType: "organization",
        targetId: "org_new",
        metadata: { name: "Nuevo negocio" },
      }
    );

    expect(h.auditWrites).toHaveLength(1);
    const values = h.auditWrites[0]!;
    expect(values).toContain("org_a");
    expect(values).toContain("user_1");
    expect(values).toContain("member");
    expect(values).toContain("organization.create");
    expect(values).toContain("organization");
    expect(values).toContain("org_new");
    expect(String(values.at(-1))).toContain("Nuevo negocio");
  });

  it("marca superadmin cuando la sesión lo es", async () => {
    const { auditPrivilegedAction } = await import("@/server/auth/audit");

    await auditPrivilegedAction(
      {
        organizationId: "org_a",
        userId: "root_1",
        role: "owner",
        isSuperadmin: true,
      } as never,
      { action: "bot_api.key.rotate" }
    );

    expect(h.auditWrites[0]).toContain("superadmin");
  });

  it("todas las rutas sensibles dejan rastro", () => {
    for (const path of AUDITED_ROUTES) {
      const route = source(path);
      expect(auditBlocks(route).length).toBeGreaterThan(0);
    }
  });

  it("el metadata de auditoría nunca lleva un token completo", () => {
    // Solo se admiten formas redactadas: `tokenLast4`, `secretLast4`,
    // `keyLast4` y el booleano `tokenProvided`.
    const forbidden: { pattern: RegExp; why: string }[] = [
      { pattern: /\btoken\b(?!Last4|Provided)/, why: "token completo" },
      { pattern: /\bclientSecret\b/, why: "client secret completo" },
      { pattern: /\bwebhookSecret\b/, why: "webhook secret completo" },
      { pattern: /\bsecret\b/, why: "secreto completo" },
      { pattern: /\bkey\b/, why: "clave completa" },
    ];
    const violations: string[] = [];

    for (const path of AUDITED_ROUTES) {
      const route = source(path);
      for (const block of auditBlocks(route)) {
        // Fuera los literales: `targetType: "bot_api_key"` no es un secreto.
        const stripped = block.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
        for (const { pattern, why } of forbidden) {
          if (pattern.test(stripped)) violations.push(`${path} → ${why}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
