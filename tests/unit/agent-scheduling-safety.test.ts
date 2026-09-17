import { describe, expect, it } from "vitest";
import { agentActionSchema } from "@/server/ai/actions";
import { resolveTargetDate } from "@/lib/time/target-date";

const NOW = new Date("2026-09-17T15:00:00.000Z");
const TZ = "America/Mexico_City";

describe("agent scheduling safety", () => {
  it("descarta una fecha inventada por el LLM en offer_slots", () => {
    const parsed = agentActionSchema(true).parse({
      action: "offer_slots",
      day: "2099-12-31",
      reply: "Tengo estos horarios",
    });

    expect(parsed.action).toBe("offer_slots");
    if (parsed.action === "offer_slots") {
      expect(parsed.day).toBeUndefined();
    }
  });

  it("'en la mañana' no se interpreta como mañana=día siguiente", () => {
    expect(resolveTargetDate("prefiero en la mañana", NOW, TZ)).toBeNull();
  });

  it("'mañana por la mañana' sí conserva mañana=día siguiente", () => {
    expect(resolveTargetDate("mañana por la mañana", NOW, TZ)?.iso).toBe("2026-09-18");
  });

  it("rechaza fechas calendáricamente imposibles", () => {
    expect(resolveTargetDate("quiero el 31/02/2026", NOW, TZ)).toBeNull();
    expect(resolveTargetDate("quiero el 2026-02-29", NOW, TZ)).toBeNull();
  });
});
