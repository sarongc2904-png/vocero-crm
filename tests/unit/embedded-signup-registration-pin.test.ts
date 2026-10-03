import { createHmac } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const graphRequest = vi.fn();

vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return { ...original, graphRequest: (...args: unknown[]) => graphRequest(...args) };
});

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

beforeAll(() => {
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.DATABASE_URL = "postgresql://t:t@localhost:5432/t";
  process.env.BETTER_AUTH_SECRET = "secret-de-prueba-embedded-signup";
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-test";
});

describe("PIN de registro del número (Embedded Signup)", () => {
  beforeEach(() => graphRequest.mockReset());

  it("es determinista, de 6 dígitos y reproducible fuera del módulo", async () => {
    const { deriveRegistrationPin } = await import("@/server/whatsapp/embedded-signup");
    const pin = deriveRegistrationPin("1234567890", "secreto-a");

    expect(pin).toMatch(/^[1-9]\d{5}$/);
    expect(deriveRegistrationPin("1234567890", "secreto-a")).toBe(pin);

    const digest = createHmac("sha256", "secreto-a")
      .update("whatsapp-registration-pin:v1:1234567890")
      .digest();
    expect(pin).toBe(String(100000 + (digest.readUInt32BE(0) % 900000)));
  });

  it("cambia con el número y con el secreto del servidor", async () => {
    const { deriveRegistrationPin } = await import("@/server/whatsapp/embedded-signup");
    const base = deriveRegistrationPin("1234567890", "secreto-a");

    expect(deriveRegistrationPin("1234567891", "secreto-a")).not.toBe(base);
    expect(deriveRegistrationPin("1234567890", "secreto-b")).not.toBe(base);
  });

  it("el registro envía el PIN derivado del secreto del servidor, sin Math.random", async () => {
    const random = vi.spyOn(Math, "random");
    graphRequest.mockResolvedValue({ success: true });
    const { deriveRegistrationPin, registerPhoneNumberIfNeeded } = await import(
      "@/server/whatsapp/embedded-signup"
    );

    await registerPhoneNumberIfNeeded("1234567890", "token-de-prueba");
    await registerPhoneNumberIfNeeded("1234567890", "token-de-prueba");

    const expected = deriveRegistrationPin("1234567890", ENCRYPTION_KEY);
    expect(graphRequest).toHaveBeenCalledTimes(2);
    for (const call of graphRequest.mock.calls) {
      expect(call[0]).toBe("1234567890/register");
      expect(call[1]).toMatchObject({
        method: "POST",
        token: "token-de-prueba",
        body: { messaging_product: "whatsapp", pin: expected },
      });
    }
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });
});
