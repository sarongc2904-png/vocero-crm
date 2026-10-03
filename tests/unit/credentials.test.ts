import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FR-040/FR-080s: el token se guarda cifrado (jamás texto plano en la fila)
 * y a la UI solo viajan los últimos 4 caracteres.
 */

const insertedRows: Record<string, unknown>[] = [];
const selectedRows: Array<{ organizationId: string }> = [];
const deletedScopes: unknown[] = [];

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([...selectedRows]),
        }),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        insertedRows.push(v);
        return {
          onConflictDoUpdate: () => Promise.resolve(),
        };
      },
    }),
    delete: () => ({
      where: (scope: unknown) => {
        deletedScopes.push(scope);
        return Promise.resolve();
      },
    }),
  }),
  schema: {
    metaCredentials: {
      organizationId: "organization_id",
      phoneNumberId: "phone_number_id",
    },
  },
}));

beforeAll(() => {
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.DATABASE_URL = "postgresql://t:t@localhost:5432/t";
  process.env.BETTER_AUTH_SECRET = "secret-de-test-suficiente";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-test";
});

beforeEach(() => {
  insertedRows.length = 0;
  selectedRows.length = 0;
  deletedScopes.length = 0;
});

describe("credenciales de WhatsApp", () => {
  it("saveCredentials cifra el token: la fila no contiene el texto plano", async () => {
    const { saveCredentials } = await import("@/server/whatsapp/credentials");
    const token = "EAAG-token-super-secreto-abcd";
    await saveCredentials({
      organizationId: "org_1",
      wabaId: "waba1",
      phoneNumberId: "pn1",
      token,
    });
    const row = insertedRows[0]!;
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(token);
    expect(row.tokenCipher).toBeTruthy();
    expect(row.tokenIv).toBeTruthy();
    expect(row.tokenTag).toBeTruthy();

    // y el cifrado es reversible con la clave de la instancia
    const { decryptSecret } = await import("@/lib/crypto");
    expect(
      decryptSecret({
        cipher: row.tokenCipher as string,
        iv: row.tokenIv as string,
        tag: row.tokenTag as string,
      })
    ).toBe(token);
  });

  it("permite reconectar el número del mismo tenant", async () => {
    const { assertPhoneNumberAvailableForOrg } = await import(
      "@/server/whatsapp/credentials"
    );
    selectedRows.push({ organizationId: "org_a" });

    await expect(
      assertPhoneNumberAvailableForOrg("org_a", "pn_1")
    ).resolves.toBeUndefined();
  });

  it("impide que otro tenant reclame un número ya conectado", async () => {
    const { assertPhoneNumberAvailableForOrg, CredentialsOwnershipError } =
      await import("@/server/whatsapp/credentials");
    selectedRows.push({ organizationId: "org_a" });

    await expect(
      assertPhoneNumberAvailableForOrg("org_b", "pn_1")
    ).rejects.toBeInstanceOf(CredentialsOwnershipError);
  });

  it("desconecta usando siempre el scope de la organización activa", async () => {
    const { deleteCredentialsByOrg } = await import(
      "@/server/whatsapp/credentials"
    );

    await deleteCredentialsByOrg("org_a");
    expect(deletedScopes).toHaveLength(1);
  });
});
