import { asc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { isValidTimeZone } from "@/lib/time/slots";

export type ServiceInput = {
  name: string;
  description?: string;
  category?: string | null;
  durationMinutes: number;
  priceCents: number;
  currency?: string;
  active?: boolean;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
};

export class BeautyCatalogError extends Error {
  constructor(
    public readonly code: "not_found" | "invalid" | "conflict",
    message: string
  ) {
    super(message);
    this.name = "BeautyCatalogError";
  }
}

export async function listServices(organizationId: string) {
  return getDb()
    .select()
    .from(schema.service)
    .where(scoped(schema.service.organizationId, organizationId))
    .orderBy(asc(schema.service.name));
}

export async function createService(organizationId: string, input: ServiceInput) {
  const rows = await getDb()
    .insert(schema.service)
    .values({
      id: newId("service"),
      organizationId,
      ...serviceValues(input),
    })
    .returning();
  return rows[0]!;
}

export async function updateService(
  organizationId: string,
  serviceId: string,
  input: Partial<ServiceInput>
) {
  const current = await getOwnService(organizationId, serviceId);
  const rows = await getDb()
    .update(schema.service)
    .set({
      ...serviceValues({
        name: input.name ?? current.name,
        description: input.description ?? current.description,
        category: input.category === undefined ? current.category : input.category,
        durationMinutes: input.durationMinutes ?? current.durationMinutes,
        priceCents: input.priceCents ?? current.priceCents,
        currency: input.currency ?? current.currency,
        active: input.active ?? current.active,
        bufferBeforeMinutes:
          input.bufferBeforeMinutes ?? current.bufferBeforeMinutes,
        bufferAfterMinutes: input.bufferAfterMinutes ?? current.bufferAfterMinutes,
      }),
      updatedAt: new Date(),
    })
    .where(
      scoped(
        schema.service.organizationId,
        organizationId,
        eq(schema.service.id, serviceId)
      )
    )
    .returning();
  return rows[0]!;
}

function serviceValues(input: ServiceInput) {
  const name = input.name.trim();
  const currency = (input.currency ?? "MXN").trim().toUpperCase();
  if (!name) throw new BeautyCatalogError("invalid", "El servicio necesita nombre");
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 5) {
    throw new BeautyCatalogError("invalid", "La duración mínima es 5 minutos");
  }
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
    throw new BeautyCatalogError("invalid", "El precio debe expresarse en centavos");
  }
  return {
    name,
    description: (input.description ?? "").trim(),
    category: input.category?.trim() || null,
    durationMinutes: input.durationMinutes,
    priceCents: input.priceCents,
    currency,
    active: input.active ?? true,
    bufferBeforeMinutes: input.bufferBeforeMinutes ?? 0,
    bufferAfterMinutes: input.bufferAfterMinutes ?? 0,
  };
}

async function getOwnService(organizationId: string, serviceId: string) {
  const rows = await getDb()
    .select()
    .from(schema.service)
    .where(
      scoped(
        schema.service.organizationId,
        organizationId,
        eq(schema.service.id, serviceId)
      )
    )
    .limit(1);
  if (!rows[0]) throw new BeautyCatalogError("not_found", "Servicio no encontrado");
  return rows[0];
}

export type ProfessionalInput = {
  name: string;
  status?: "active" | "inactive";
  phone?: string | null;
  email?: string | null;
  userId?: string | null;
  timezone: string;
  color?: string | null;
  serviceIds?: string[];
};

export async function listProfessionals(organizationId: string) {
  const db = getDb();
  const [professionals, assignments] = await Promise.all([
    db
      .select()
      .from(schema.professional)
      .where(scoped(schema.professional.organizationId, organizationId))
      .orderBy(asc(schema.professional.name)),
    db
      .select({
        professionalId: schema.professionalService.professionalId,
        serviceId: schema.professionalService.serviceId,
      })
      .from(schema.professionalService)
      .where(scoped(schema.professionalService.organizationId, organizationId)),
  ]);
  return professionals.map((professional) => ({
    ...professional,
    serviceIds: assignments
      .filter((item) => item.professionalId === professional.id)
      .map((item) => item.serviceId),
  }));
}

export async function createProfessional(
  organizationId: string,
  input: ProfessionalInput
) {
  validateProfessional(input);
  const db = getDb();
  return db.transaction(async (tx) => {
    await assertOwnServices(tx, organizationId, input.serviceIds ?? []);
    const rows = await tx
      .insert(schema.professional)
      .values({
        id: newId("professional"),
        organizationId,
        name: input.name.trim(),
        status: input.status ?? "active",
        phone: input.phone?.trim() || null,
        email: input.email?.trim() || null,
        userId: input.userId ?? null,
        timezone: input.timezone,
        color: input.color?.trim() || null,
      })
      .returning();
    const professional = rows[0]!;
    await insertAssignments(tx, organizationId, professional.id, input.serviceIds ?? []);
    return { ...professional, serviceIds: input.serviceIds ?? [] };
  });
}

export async function updateProfessional(
  organizationId: string,
  professionalId: string,
  input: Partial<ProfessionalInput>
) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const currentRows = await tx
      .select()
      .from(schema.professional)
      .where(
        scoped(
          schema.professional.organizationId,
          organizationId,
          eq(schema.professional.id, professionalId)
        )
      )
      .limit(1);
    const current = currentRows[0];
    if (!current) {
      throw new BeautyCatalogError("not_found", "Profesional no encontrado");
    }
    const next: ProfessionalInput = {
      name: input.name ?? current.name,
      status: input.status ?? current.status,
      phone: input.phone === undefined ? current.phone : input.phone,
      email: input.email === undefined ? current.email : input.email,
      userId: input.userId === undefined ? current.userId : input.userId,
      timezone: input.timezone ?? current.timezone,
      color: input.color === undefined ? current.color : input.color,
      serviceIds: input.serviceIds,
    };
    validateProfessional(next);
    if (input.serviceIds) await assertOwnServices(tx, organizationId, input.serviceIds);
    const rows = await tx
      .update(schema.professional)
      .set({
        name: next.name.trim(),
        status: next.status,
        phone: next.phone?.trim() || null,
        email: next.email?.trim() || null,
        userId: next.userId ?? null,
        timezone: next.timezone,
        color: next.color?.trim() || null,
        updatedAt: new Date(),
      })
      .where(
        scoped(
          schema.professional.organizationId,
          organizationId,
          eq(schema.professional.id, professionalId)
        )
      )
      .returning();
    if (input.serviceIds) {
      await tx
        .delete(schema.professionalService)
        .where(
          scoped(
            schema.professionalService.organizationId,
            organizationId,
            eq(schema.professionalService.professionalId, professionalId)
          )
        );
      await insertAssignments(tx, organizationId, professionalId, input.serviceIds);
    }
    return rows[0]!;
  });
}

function validateProfessional(input: ProfessionalInput) {
  if (!input.name.trim()) {
    throw new BeautyCatalogError("invalid", "La profesional necesita nombre");
  }
  if (!isValidTimeZone(input.timezone)) {
    throw new BeautyCatalogError("invalid", "Zona horaria desconocida");
  }
}

type DbTransaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

async function assertOwnServices(
  tx: DbTransaction,
  organizationId: string,
  serviceIds: string[]
) {
  const unique = [...new Set(serviceIds)];
  if (unique.length === 0) return;
  const rows = await tx
    .select({ id: schema.service.id })
    .from(schema.service)
    .where(
      scoped(
        schema.service.organizationId,
        organizationId,
        inArray(schema.service.id, unique)
      )
    );
  if (rows.length !== unique.length) {
    throw new BeautyCatalogError(
      "not_found",
      "Uno o más servicios no pertenecen a esta organización"
    );
  }
}

async function insertAssignments(
  tx: DbTransaction,
  organizationId: string,
  professionalId: string,
  serviceIds: string[]
) {
  const unique = [...new Set(serviceIds)];
  if (unique.length === 0) return;
  await tx.insert(schema.professionalService).values(
    unique.map((serviceId) => ({
      id: newId("professionalService"),
      organizationId,
      professionalId,
      serviceId,
    }))
  );
}
