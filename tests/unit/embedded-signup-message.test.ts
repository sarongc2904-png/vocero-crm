import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMBEDDED_SIGNUP_SELECTION_TIMEOUT_MS,
  isTrustedFacebookOrigin,
  parseEmbeddedSignupMessage,
} from "@/lib/meta/embedded-signup-message";

/**
 * Solo FINISH exacto representa una selección completa. Las variantes
 * FINISH_* describen otros desenlaces y se cierran como parciales aunque
 * incluyan IDs.
 */

const ORIGIN = "https://www.facebook.com";
const IDS = { waba_id: "1234567890", phone_number_id: "9876543210", business_id: "555" };

function message(event: string, data?: Record<string, unknown>) {
  return { type: "WA_EMBEDDED_SIGNUP", event, ...(data ? { data } : {}) };
}

describe("origen del postMessage", () => {
  it.each([
    "https://www.facebook.com",
    "https://web.facebook.com",
    "https://business.facebook.com",
    "https://facebook.com",
  ])("acepta %s", (origin) => {
    expect(isTrustedFacebookOrigin(origin)).toBe(true);
  });

  it.each([
    "https://evilfacebook.com",
    "http://www.facebook.com",
    "https://www.facebook.com.evil.com",
    "https://facebook.co",
    "null",
    "",
    "no es una url",
  ])("rechaza %s", (origin) => {
    expect(isTrustedFacebookOrigin(origin)).toBe(false);
    expect(parseEmbeddedSignupMessage(origin, message("FINISH", IDS))).toEqual({
      kind: "ignore",
    });
  });
});

describe("FINISH", () => {
  it("FINISH de v3 con waba_id y phone_number_id => finish", () => {
    expect(parseEmbeddedSignupMessage(ORIGIN, message("FINISH", IDS))).toEqual({
      kind: "finish",
      event: "FINISH",
      wabaId: "1234567890",
      phoneNumberId: "9876543210",
    });
  });

  it.each([
    "FINISH_ONLY_WABA",
    "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
    "FINISH_OBO_MIGRATION",
    "FINISH_GRANT_ONLY_API_ACCESS",
  ])("variante %s con ambos IDs => partial", (event) => {
    expect(parseEmbeddedSignupMessage(ORIGIN, message(event, IDS))).toEqual({
      kind: "partial",
      event,
    });
  });

  it.each([
    "FINISH",
    "FINISH_ONLY_WABA",
    "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
    "FINISH_OBO_MIGRATION",
    "FINISH_GRANT_ONLY_API_ACCESS",
  ])("%s sin phone_number_id => partial", (event) => {
    expect(
      parseEmbeddedSignupMessage(ORIGIN, message(event, { waba_id: "1234567890" }))
    ).toEqual({ kind: "partial", event });
  });

  it("FINISH sin data => partial", () => {
    expect(parseEmbeddedSignupMessage(ORIGIN, message("FINISH"))).toEqual({
      kind: "partial",
      event: "FINISH",
    });
  });

  it("FINISH con phone_number_id pero sin waba_id => partial", () => {
    expect(
      parseEmbeddedSignupMessage(ORIGIN, message("FINISH", { phone_number_id: "9876543210" }))
    ).toEqual({ kind: "partial", event: "FINISH" });
  });

  it("campos en camelCase no cuentan como IDs => partial", () => {
    expect(
      parseEmbeddedSignupMessage(
        ORIGIN,
        message("FINISH", { wabaId: "1234567890", phoneNumberId: "9876543210" })
      )
    ).toEqual({ kind: "partial", event: "FINISH" });
  });

  it("IDs vacíos o no textuales no cuentan => partial", () => {
    expect(
      parseEmbeddedSignupMessage(ORIGIN, message("FINISH", { waba_id: " ", phone_number_id: 98 }))
    ).toEqual({ kind: "partial", event: "FINISH" });
  });

  it("el orden de los campos no importa", () => {
    const reordered = {
      data: { phone_number_id: "9876543210", business_id: "555", waba_id: "1234567890" },
      event: "FINISH",
      type: "WA_EMBEDDED_SIGNUP",
    };
    expect(parseEmbeddedSignupMessage(ORIGIN, reordered)).toMatchObject({
      kind: "finish",
      wabaId: "1234567890",
      phoneNumberId: "9876543210",
    });
  });
});

describe("CANCEL y ERROR", () => {
  it("CANCEL simple (abandono con current_step) => cancel", () => {
    expect(
      parseEmbeddedSignupMessage(ORIGIN, message("CANCEL", { current_step: "PHONE_NUMBER_SETUP" }))
    ).toEqual({ kind: "cancel" });
  });

  it("CANCEL sin data => cancel", () => {
    expect(parseEmbeddedSignupMessage(ORIGIN, message("CANCEL"))).toEqual({ kind: "cancel" });
  });

  it("CANCEL con error_message y error_code (formato v4) => error, sin texto de Meta", () => {
    const parsed = parseEmbeddedSignupMessage(
      ORIGIN,
      message("CANCEL", {
        error_message: "Texto libre de Meta con datos",
        error_code: "524126",
        session_id: "f34b51dab5e0498",
        timestamp: "1689197393",
      })
    );
    expect(parsed).toEqual({ kind: "error", errorCode: "524126", sessionId: "f34b51dab5e0498" });
    expect(JSON.stringify(parsed)).not.toContain("Texto libre");
  });

  it("CANCEL con solo error_message => error", () => {
    expect(
      parseEmbeddedSignupMessage(ORIGIN, message("CANCEL", { error_message: "falló" }))
    ).toEqual({ kind: "error", errorCode: null, sessionId: null });
  });

  it("CANCEL con solo error_code numérico => error", () => {
    expect(parseEmbeddedSignupMessage(ORIGIN, message("CANCEL", { error_code: 524126 }))).toEqual({
      kind: "error",
      errorCode: "524126",
      sessionId: null,
    });
  });

  it("ERROR (v3) se mantiene => error", () => {
    expect(
      parseEmbeddedSignupMessage(
        ORIGIN,
        message("ERROR", { error_message: "x", error_code: "1", session_id: "abc" })
      )
    ).toEqual({ kind: "error", errorCode: "1", sessionId: "abc" });
    expect(parseEmbeddedSignupMessage(ORIGIN, message("ERROR"))).toEqual({
      kind: "error",
      errorCode: null,
      sessionId: null,
    });
  });

  it("error_code y session_id con caracteres raros se descartan para el registro", () => {
    expect(
      parseEmbeddedSignupMessage(
        ORIGIN,
        message("CANCEL", { error_code: "12 <script>", session_id: "a".repeat(200) })
      )
    ).toEqual({ kind: "error", errorCode: null, sessionId: null });
  });
});

describe("formato y tipos", () => {
  it("acepta el mensaje como string JSON", () => {
    expect(
      parseEmbeddedSignupMessage(ORIGIN, JSON.stringify(message("FINISH", IDS)))
    ).toMatchObject({ kind: "finish", wabaId: "1234567890" });
  });

  it.each([
    ["JSON inválido", "{no es json"],
    ["null", null],
    ["número", 42],
    ["string suelto", "FINISH"],
    ["otro type", { type: "OTRO", event: "FINISH", data: IDS }],
    ["sin type", { event: "FINISH", data: IDS }],
    ["evento desconocido", message("PROGRESS", IDS)],
    ["evento no textual", { type: "WA_EMBEDDED_SIGNUP", event: 3, data: IDS }],
    ["finish en minúsculas", message("finish", IDS)],
  ])("%s => ignore", (_label, data) => {
    expect(parseEmbeddedSignupMessage(ORIGIN, data)).toEqual({ kind: "ignore" });
  });
});

describe("plazo para la selección tras recibir el code", () => {
  it("es menor que la vida de 30 s del code de Embedded Signup", () => {
    expect(EMBEDDED_SIGNUP_SELECTION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(EMBEDDED_SIGNUP_SELECTION_TIMEOUT_MS).toBeLessThan(30_000);
  });
});

describe("el botón usa el parser y no registra datos sensibles", () => {
  const button = readFileSync(
    resolve(process.cwd(), "src/components/settings/embedded-signup-button.tsx"),
    "utf8"
  );

  it("delegó la lectura del postMessage al parser puro", () => {
    expect(button).toContain("parseEmbeddedSignupMessage(event.origin, event.data)");
    expect(button).toContain("EMBEDDED_SIGNUP_SELECTION_TIMEOUT_MS");
  });

  it("los logs solo llevan error_code y session_id", () => {
    const logs = button.match(/console\.(?:log|info|warn|error)\([^;]*;/g) ?? [];
    expect(logs.length).toBeGreaterThan(0);
    for (const log of logs) {
      expect(log).not.toMatch(/\bcode\b(?!=)|wabaId|phoneNumberId|token|authResponse/);
      expect(log).toMatch(/errorCode|sessionId/);
    }
  });

  it("no cambia los extras de FB.login", () => {
    expect(button).toContain('extras: { setup: {}, featureType: "", sessionInfoVersion: "3" }');
  });
});
