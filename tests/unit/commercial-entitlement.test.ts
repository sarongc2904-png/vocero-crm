import { describe, expect, it } from "vitest";
import { isCommerciallyAllowed } from "@/server/commercial/entitlement";

describe("entitlement comercial", () => {
  const now = new Date("2026-09-19T12:00:00.000Z");

  it("permite plan activo y trial vigente", () => {
    expect(isCommerciallyAllowed("active", null, now)).toBe(true);
    expect(
      isCommerciallyAllowed(
        "trial",
        new Date("2026-09-22T12:00:00.000Z"),
        now
      )
    ).toBe(true);
  });

  it("expira sin borrar datos ni confundir estados comerciales", () => {
    expect(
      isCommerciallyAllowed(
        "trial",
        new Date("2026-09-19T11:59:59.000Z"),
        now
      )
    ).toBe(false);
    expect(isCommerciallyAllowed("past_due", null, now)).toBe(false);
    expect(isCommerciallyAllowed("suspended", null, now)).toBe(false);
    expect(isCommerciallyAllowed("cancelled", null, now)).toBe(false);
  });
});
