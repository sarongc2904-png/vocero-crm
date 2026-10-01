import { describe, expect, it } from "vitest";
import { agentActionSchema, degradeAction } from "@/server/ai/actions";

describe("contrato de respuesta del agente", () => {
  it("rechaza silencio como salida exitosa del proveedor", () => {
    const schema = agentActionSchema(false);

    expect(schema.safeParse({ action: "none" }).success).toBe(false);
    expect(
      schema.safeParse({ action: "update_lead", note: "Interés alto" }).success
    ).toBe(false);
    expect(
      schema.safeParse({ action: "move_stage", stage: "Interesado" }).success
    ).toBe(false);
  });

  it("acepta mutaciones que también responden al cliente", () => {
    const schema = agentActionSchema(false);

    expect(
      schema.safeParse({
        action: "update_lead",
        note: "Interés alto",
        reply: "Perfecto, te ayudo con eso.",
      }).success
    ).toBe(true);
    expect(
      schema.safeParse({
        action: "move_stage",
        stage: "Interesado",
        reply: "Perfecto, continuemos.",
      }).success
    ).toBe(true);
  });

  it("conserva none como degradación interna fail-closed", () => {
    expect(degradeAction({ action: "cancel_booking" })).toEqual({
      action: "none",
    });
  });
});
