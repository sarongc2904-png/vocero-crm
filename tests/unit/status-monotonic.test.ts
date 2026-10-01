import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isUpgrade, upgradeableStatuses } from "@/server/inbox/status";

describe("estados monotónicos del mensaje (FR-004)", () => {
  it("progresión normal: pending → sent → delivered → read", () => {
    expect(isUpgrade("pending", "sent")).toBe(true);
    expect(isUpgrade("sent", "delivered")).toBe(true);
    expect(isUpgrade("delivered", "read")).toBe(true);
  });

  it("nunca degrada: un delivered tardío no pisa read", () => {
    expect(isUpgrade("read", "delivered")).toBe(false);
    expect(isUpgrade("delivered", "sent")).toBe(false);
    expect(isUpgrade("sent", "pending")).toBe(false);
  });

  it("mismo estado no re-aplica", () => {
    expect(isUpgrade("delivered", "delivered")).toBe(false);
  });

  it("failed aplica desde cualquier estado (una sola vez)", () => {
    expect(isUpgrade("pending", "failed")).toBe(true);
    expect(isUpgrade("read", "failed")).toBe(true);
    expect(isUpgrade("failed", "failed")).toBe(false);
  });

  it("estados desconocidos se ignoran", () => {
    expect(isUpgrade("sent", "warning")).toBe(false);
  });

  it("expone los únicos predecesores válidos de cada transición", () => {
    expect(upgradeableStatuses("sent")).toEqual(["pending"]);
    expect(upgradeableStatuses("delivered")).toEqual(["pending", "sent"]);
    expect(upgradeableStatuses("read")).toEqual([
      "pending",
      "sent",
      "delivered",
    ]);
    expect(upgradeableStatuses("failed")).toEqual([
      "pending",
      "sent",
      "delivered",
      "read",
    ]);
  });

  it("aplica la transición y el tenant scope dentro del mismo UPDATE", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/server/inbox/status.ts"),
      "utf8"
    ).replace(/\r\n/g, "\n");

    expect(source).not.toContain(".select({");
    expect(source).toContain("eq(schema.message.organizationId, organizationId)");
    expect(source).toContain("eq(schema.message.waMessageId, status.id)");
    expect(source).toContain("inArray(schema.message.status, allowedCurrent)");
    expect(source).toContain(".returning({");
  });
});
