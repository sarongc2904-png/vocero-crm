import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0037 — aislamiento por negocio de las cotizaciones contra un Postgres REAL.
 *
 * Prueba la última frontera: aunque el código de la app se equivocara, la
 * BASE rechaza que una cotización, línea o enlace de un negocio apunte a
 * filas de otro (FKs compuestas), que dos negocios compartan folio y que los
 * totales queden incoherentes.
 *
 * Opcional: corre solo con `VOCERO_TEST_PG_URL` apuntando a una base
 * DESCARTABLE con las migraciones aplicadas. Sin la variable se omite, como
 * en CI. Ejemplo:
 *
 *   VOCERO_TEST_PG_URL=postgres://u@127.0.0.1:55432/db pnpm vitest run \
 *     tests/unit/quotes-tenant-isolation-postgres.test.ts
 */

const PG_URL = process.env.VOCERO_TEST_PG_URL;

type Tenant = { org: string; contact: string; service: string };

let sql: postgres.Sql;
let a: Tenant;
let b: Tenant;
let seq = 0;

function tag(): string {
  seq += 1;
  return `${Date.now().toString(36)}${seq}${randomBytes(3).toString("hex")}`;
}

async function seedTenant(): Promise<Tenant> {
  const t = tag();
  const tenant = { org: `org_qt${t}`, contact: `ct_qt${t}`, service: `svc_qt${t}` };
  await sql`insert into organization (id, name) values (${tenant.org}, ${`Org ${t}`})`;
  await sql`insert into contact (id, organization_id, wa_identity, name)
            values (${tenant.contact}, ${tenant.org}, ${`52155${t}`}, 'Cliente')`;
  await sql`insert into service (id, organization_id, name, duration_minutes, price_cents)
            values (${tenant.service}, ${tenant.org}, ${`Servicio ${t}`}, 60, 150000)`;
  return tenant;
}

async function nextNumber(org: string): Promise<number> {
  const rows = await sql<{ last_number: number }[]>`
    insert into quote_counter (organization_id, last_number) values (${org}, 1)
    on conflict (organization_id)
    do update set last_number = quote_counter.last_number + 1, updated_at = now()
    returning last_number`;
  return rows[0]!.last_number;
}

async function insertQuote(input: {
  org: string;
  contact: string;
  number?: number;
  subtotal?: number;
  tax?: number;
  total?: number;
  pricesIncludeTax?: boolean;
}): Promise<string> {
  const id = `qt_${tag()}`;
  const number = input.number ?? (await nextNumber(input.org));
  const subtotal = input.subtotal ?? 100000;
  const tax = input.tax ?? 16000;
  const includes = input.pricesIncludeTax ?? false;
  const total = input.total ?? (includes ? subtotal : subtotal + tax);
  await sql`insert into quote (id, organization_id, contact_id, number, prices_include_tax,
              tax_rate_bps, subtotal_cents, tax_cents, total_cents, valid_until)
            values (${id}, ${input.org}, ${input.contact}, ${number}, ${includes},
              1600, ${subtotal}, ${tax}, ${total}, now() + interval '15 days')`;
  return id;
}

function tokenHash(): string {
  return createHash("sha256").update(randomBytes(32)).digest("hex");
}

/** Espera el error de Postgres por su código SQLSTATE. */
async function expectPgError(run: () => Promise<unknown>, code: string, constraint?: string) {
  let error: unknown = null;
  try {
    await run();
  } catch (err) {
    error = err;
  }
  expect(error, "la base debía rechazar la escritura").not.toBeNull();
  const pg = error as { code?: string; constraint_name?: string };
  expect(pg.code).toBe(code);
  if (constraint) expect(pg.constraint_name).toBe(constraint);
}

const FK_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

describe.skipIf(!PG_URL)("cotizaciones: aislamiento por organization_id en PostgreSQL", () => {
  beforeAll(async () => {
    sql = postgres(PG_URL!, { max: 4, onnotice: () => {} });
    a = await seedTenant();
    b = await seedTenant();
  });

  afterAll(async () => {
    if (!sql) return;
    // organization ON DELETE CASCADE limpia todo lo sembrado.
    await sql`delete from organization where id like 'org_qt%'`;
    await sql.end();
  });

  it("una cotización del negocio A no puede usar un contacto del negocio B", async () => {
    await expectPgError(
      () => insertQuote({ org: a.org, contact: b.contact }),
      FK_VIOLATION,
      "quote_contact_id_tenant_fk"
    );
  });

  it("una línea no puede colgar de la cotización de otro negocio", async () => {
    const quoteB = await insertQuote({ org: b.org, contact: b.contact });
    await expectPgError(
      () => sql`insert into quote_item (id, organization_id, quote_id, position, description,
                  quantity_milli, unit_price_cents, line_total_cents)
                values (${`qti_${tag()}`}, ${a.org}, ${quoteB}, 0, 'Intruso', 1000, 100, 100)`,
      FK_VIOLATION,
      "quote_item_quote_id_tenant_fk"
    );
  });

  it("una línea no puede referenciar un servicio del catálogo de otro negocio", async () => {
    const quoteA = await insertQuote({ org: a.org, contact: a.contact });
    await expectPgError(
      () => sql`insert into quote_item (id, organization_id, quote_id, service_id, position,
                  description, quantity_milli, unit_price_cents, line_total_cents)
                values (${`qti_${tag()}`}, ${a.org}, ${quoteA}, ${b.service}, 0, 'Servicio ajeno',
                  1000, 150000, 150000)`,
      FK_VIOLATION,
      "quote_item_service_id_tenant_fk"
    );
  });

  it("un enlace público no puede apuntar a la cotización de otro negocio", async () => {
    const quoteB = await insertQuote({ org: b.org, contact: b.contact });
    await expectPgError(
      () => sql`insert into quote_link (id, organization_id, quote_id, token_hash, expires_at)
                values (${`qtl_${tag()}`}, ${a.org}, ${quoteB}, ${tokenHash()}, now() + interval '15 days')`,
      FK_VIOLATION,
      "quote_link_quote_id_tenant_fk"
    );
  });

  it("los datos propios sí se aceptan (control positivo)", async () => {
    const quoteA = await insertQuote({ org: a.org, contact: a.contact });
    await sql`insert into quote_item (id, organization_id, quote_id, service_id, position,
                description, quantity_milli, unit_price_cents, line_total_cents)
              values (${`qti_${tag()}`}, ${a.org}, ${quoteA}, ${a.service}, 0, 'Servicio propio',
                1500, 100000, 150000)`;
    await sql`insert into quote_link (id, organization_id, quote_id, token_hash, expires_at)
              values (${`qtl_${tag()}`}, ${a.org}, ${quoteA}, ${tokenHash()}, now() + interval '15 days')`;
    const items = await sql`select 1 from quote_item where organization_id = ${a.org} and quote_id = ${quoteA}`;
    expect(items).toHaveLength(1);
  });

  it("cada negocio tiene su propia numeración de folios, sin huecos ni duplicados", async () => {
    const c = await seedTenant();
    const d = await seedTenant();
    // Altas concurrentes intercaladas de dos negocios.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => nextNumber(i % 2 === 0 ? c.org : d.org).then((n) => ({ org: i % 2 === 0 ? c.org : d.org, n })))
    );
    const forC = results.filter((r) => r.org === c.org).map((r) => r.n).sort((x, y) => x - y);
    const forD = results.filter((r) => r.org === d.org).map((r) => r.n).sort((x, y) => x - y);
    expect(forC).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(forD).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
  });

  it("el mismo folio puede existir en dos negocios, pero nunca repetirse dentro de uno", async () => {
    const c = await seedTenant();
    const d = await seedTenant();
    await insertQuote({ org: c.org, contact: c.contact, number: 1 });
    await insertQuote({ org: d.org, contact: d.contact, number: 1 });
    await expectPgError(
      () => insertQuote({ org: c.org, contact: c.contact, number: 1 }),
      UNIQUE_VIOLATION,
      "quote_org_number_uq"
    );
  });

  it("la base rechaza totales incoherentes", async () => {
    // Sin IVA incluido: total debe ser subtotal + IVA.
    await expectPgError(
      () => insertQuote({ org: a.org, contact: a.contact, subtotal: 100000, tax: 16000, total: 100000 }),
      CHECK_VIOLATION,
      "quote_total_ck"
    );
    // Con IVA incluido: total debe ser el subtotal.
    await expectPgError(
      () =>
        insertQuote({
          org: a.org,
          contact: a.contact,
          pricesIncludeTax: true,
          subtotal: 116000,
          tax: 16000,
          total: 132000,
        }),
      CHECK_VIOLATION,
      "quote_total_ck"
    );
  });

  it("el enlace solo acepta un hash SHA-256 y nunca el mismo dos veces", async () => {
    const quoteA = await insertQuote({ org: a.org, contact: a.contact });
    await expectPgError(
      () => sql`insert into quote_link (id, organization_id, quote_id, token_hash, expires_at)
                values (${`qtl_${tag()}`}, ${a.org}, ${quoteA}, 'token-en-claro', now())`,
      CHECK_VIOLATION,
      "quote_link_token_hash_ck"
    );
    const hash = tokenHash();
    await sql`insert into quote_link (id, organization_id, quote_id, token_hash, expires_at)
              values (${`qtl_${tag()}`}, ${a.org}, ${quoteA}, ${hash}, now())`;
    await expectPgError(
      () => sql`insert into quote_link (id, organization_id, quote_id, token_hash, expires_at)
                values (${`qtl_${tag()}`}, ${a.org}, ${quoteA}, ${hash}, now())`,
      UNIQUE_VIOLATION,
      "quote_link_token_hash_uq"
    );
  });

  it("borrar un negocio borra sus cotizaciones y no toca las del otro", async () => {
    const c = await seedTenant();
    const d = await seedTenant();
    const quoteC = await insertQuote({ org: c.org, contact: c.contact });
    const quoteD = await insertQuote({ org: d.org, contact: d.contact });
    await sql`delete from organization where id = ${c.org}`;
    expect(await sql`select 1 from quote where id = ${quoteC}`).toHaveLength(0);
    expect(await sql`select 1 from quote where id = ${quoteD}`).toHaveLength(1);
  });

  it("borrar un servicio deja la línea intacta con su precio copiado", async () => {
    const c = await seedTenant();
    const quoteC = await insertQuote({ org: c.org, contact: c.contact });
    const itemId = `qti_${tag()}`;
    await sql`insert into quote_item (id, organization_id, quote_id, service_id, position,
                description, quantity_milli, unit_price_cents, line_total_cents)
              values (${itemId}, ${c.org}, ${quoteC}, ${c.service}, 0, 'Servicio', 1000, 150000, 150000)`;
    await sql`delete from service where id = ${c.service}`;
    const rows = await sql<{ service_id: string | null; organization_id: string; unit_price_cents: string }[]>`
      select service_id, organization_id, unit_price_cents from quote_item where id = ${itemId}`;
    expect(rows[0]).toMatchObject({ service_id: null, organization_id: c.org, unit_price_cents: "150000" });
  });
});
