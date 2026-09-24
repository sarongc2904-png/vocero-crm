import { describe, expect, it } from "vitest";
import { matchesHandoffIntent } from "@/server/ai/handoff";

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
