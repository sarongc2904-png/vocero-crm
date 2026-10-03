import { describe, expect, it } from "vitest";
import {
  matchesConfiguredEscalation,
  matchesHandoffIntent,
  rejectedHandoffFallback,
  shouldAllowModelHandoff,
} from "@/server/ai/handoff";

describe("patrón de respaldo de handoff (FR-022 / SC-006)", () => {
  it.each([
    "quiero hablar con un humano",
    "¿puedo hablar con un asesor?",
    "necesito comunicarme con alguien",
    "quiero contactar a una persona real",
    "quiero hablar con alguien por favor",
    "me pasas a un asesor",
    "prefiero atención humana",
    "atencion humana por favor",
  ])("dispara: %s", (text) => {
    expect(matchesHandoffIntent(text)).toBe(true);
  });

  it.each([
    "somos 4 personas", // el caso canónico que NO debe disparar
    "somos cuatro personas y queremos reservar",
    "¿tienen taladros?",
    "la persona que me atendió ayer fue amable",
    "mi humano favorito es mi hijo",
    "el asesor fiscal ya me cobró", // sin verbo de contacto ni "un asesor"
  ])("NO dispara: %s", (text) => {
    expect(matchesHandoffIntent(text)).toBe(false);
  });
});


describe("handoff durable", () => {
  it("la transición es atómica y pausa la IA", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(process.cwd(), "src/server/ai/pipeline.ts"),
      "utf8"
    );

    expect(source).toContain("aiEnabled: false");
    expect(source).toContain("eq(schema.conversation.aiEnabled, true)");
    expect(source).toContain("const claimed = await applyHandoff");
    expect(source).toContain("if (claimed && action.farewell)");
  });

  it("precio no obliga a escalar", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const prompt = readFileSync(
      resolve(process.cwd(), "src/server/ai/prompts.ts"),
      "utf8"
    );

    expect(prompt).toContain("Preguntas normales sobre precio");
    expect(prompt).toContain("NO son handoff por sí solas");
    expect(prompt).toContain("NO inventes ni escales automáticamente");
  });
});


describe("política determinista de handoff del modelo", () => {
  it.each([
    "Hola, me interesa lo que ofrecen",
    "¿Qué opciones manejan?",
    "¿Cuánto cuesta?",
    "Tengo una consulta importante",
    "ola, me interesa lo q ofrecen",
  ])("NO permite handoff comercial prematuro: %s", (text) => {
    expect(shouldAllowModelHandoff(text, null)).toBe(false);
  });

  it("permite petición explícita de humano", () => {
    expect(
      shouldAllowModelHandoff("Prefiero hablar con una persona", null)
    ).toBe(true);
  });

  it("una regla de quejas solo aplica cuando el mensaje contiene una queja", () => {
    const rules = "Escalar quejas, reclamos y clientes enojados.";
    expect(matchesConfiguredEscalation("Tengo una consulta importante", rules)).toBe(false);
    expect(matchesConfiguredEscalation("Estoy molesto por un problema", rules)).toBe(true);
  });

  it("una regla de urgencia no convierte una consulta normal en handoff", () => {
    const rules = "Escalar urgencias, emergencias o situaciones de riesgo.";
    expect(matchesConfiguredEscalation("Quiero conocer sus servicios", rules)).toBe(false);
    expect(matchesConfiguredEscalation("Es una urgencia, necesito ayuda", rules)).toBe(true);
  });

  it("reglas de pagos y descuentos requieren señal equivalente del cliente", () => {
    expect(
      matchesConfiguredEscalation(
        "Necesito ayuda con una factura",
        "Escalar problemas de pagos y facturación"
      )
    ).toBe(true);
    expect(
      matchesConfiguredEscalation(
        "¿Qué opciones manejan?",
        "Escalar descuentos y negociaciones especiales"
      )
    ).toBe(false);
  });
});


describe("fallback tras handoff rechazado", () => {
  it("reconoce frustración y pide contexto para resolver", () => {
    expect(
      rejectedHandoffFallback(
        "Estoy molesto porque tuve un problema y necesito una solución."
      )
    ).toBe(
      "Entiendo que tuvo un problema y quiero ayudarle a resolverlo. ¿Puede contarme qué ocurrió?"
    );
  });

  it("sin petición concreta invita brevemente a continuar", () => {
    expect(rejectedHandoffFallback("Tengo una consulta importante")).toBe(
      "Con gusto. ¿En qué le puedo ayudar?"
    );
  });

  it("ante una petición concreta nombra el tema, admite que no está confirmado y ofrece un asesor", () => {
    expect(rejectedHandoffFallback("¿Tienen algún descuento?")).toBe(
      "Sobre descuentos o promociones, por ahora no tengo información confirmada para compartirle por este medio. Si desea que un asesor se lo confirme, solo escríbame que quiere hablar con un asesor."
    );
  });

  it("respeta el tuteo solo cuando el tono del perfil lo pide", () => {
    expect(rejectedHandoffFallback("¿Cuánto cuesta?", "Cercano, tutea al cliente")).toBe(
      "Sobre el precio, por ahora no tengo información confirmada para compartirte por este medio. Si quieres que un asesor te lo confirme, solo escríbeme que quieres hablar con un asesor."
    );
    expect(rejectedHandoffFallback("¿Cuánto cuesta?", "Profesional y cercano")).toContain(
      "compartirle"
    );
  });

  it("pipeline usa el fallback contextual después del retry rechazado", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");

    const source = readFileSync(
      resolve(process.cwd(), "src/server/ai/pipeline.ts"),
      "utf8"
    );

    expect(source).toContain("rejectedHandoffFallback(inboundText, profile.tone)");
  });
});
