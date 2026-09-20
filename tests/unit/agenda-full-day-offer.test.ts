import { beforeEach, describe, expect, it, vi } from "vitest";
import { expandWorkingDayToUtc, labelInTz, timeInTz } from "@/lib/time/slots";
import { findOffered } from "@/server/agenda/offers";
import type { OfferedSlot } from "@/server/agenda/offers";

const DAY = "2026-09-20";
const TIMEZONE = "America/Matamoros";
const settings = {
  weeklyHours: { sun: [{ start: "09:00", end: "17:00" }] },
  slotMinutes: 30,
  bufferMinutes: 10,
  minNoticeHours: 0,
  maxDaysAhead: 14,
  timezone: TIMEZONE,
  connector: "google" as const,
  meetingLink: null,
};
const slots = expandWorkingDayToUtc(
  DAY,
  settings.weeklyHours.sun,
  TIMEZONE,
  settings.slotMinutes,
  settings.bufferMinutes
).map((slot) => ({ ...slot, label: labelInTz(slot.startUtc, TIMEZONE) }));

const mocks = vi.hoisted(() => ({
  computeAvailability: vi.fn(),
  replaceOffers: vi.fn(
    async (_organizationId: string, _conversationId: string, _slots: OfferedSlot[]) => {}
  ),
  createSessionBooking: vi.fn(),
}));

vi.mock("@/server/agenda/settings", () => ({ getSettings: async () => settings }));
vi.mock("@/server/agenda/availability", () => ({
  computeAvailability: mocks.computeAvailability,
}));
vi.mock("@/server/agenda/offers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/offers")>();
  return { ...original, replaceOffers: mocks.replaceOffers };
});
vi.mock("@/server/agenda/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/service")>();
  return { ...original, createSessionBooking: mocks.createSessionBooking };
});

describe("domingo completo 09:00–17:00 con buffer de 10 minutos", () => {
  beforeEach(() => {
    mocks.replaceOffers.mockClear();
    mocks.createSessionBooking.mockReset();
    mocks.computeAvailability.mockResolvedValue(slots);
    mocks.createSessionBooking.mockImplementation(async (input: { startUtc: string }) => ({
      booking: { durationMinutes: 30 },
      meetingLink: null,
      linkPending: false,
      label: labelInTz(input.startUtc, TIMEZONE),
    }));
  });

  it("ofrece y persiste exactamente los 12 slots del día solicitado", async () => {
    const { offerSlots } = await import("@/server/agenda/agent");
    const turn = await offerSlots({
      organizationId: "org_1",
      conversationId: "cv_1",
      day: DAY,
    });

    const expectedTimes = [
      "09:00", "09:40", "10:20", "11:00", "11:40", "12:20",
      "13:00", "13:40", "14:20", "15:00", "15:40", "16:20",
    ];
    expect(slots).toHaveLength(12);
    expect(slots.map((slot) => timeInTz(slot.startUtc, TIMEZONE))).toEqual(
      expectedTimes
    );
    expect(turn.text.match(/^• /gm)).toHaveLength(12);
    for (const time of expectedTimes) expect(turn.text).toContain(`• ${time}`);

    const persisted = mocks.replaceOffers.mock.calls[0]![2];
    expect(persisted).toHaveLength(12);
    expect(findOffered(persisted, slots.at(-1)!.startUtc)).not.toBeNull();
  });

  it("permite enviar a reserva el último slot de las 16:20", async () => {
    const { bookSlot } = await import("@/server/agenda/agent");
    const last = slots.at(-1)!;
    const turn = await bookSlot({
      organizationId: "org_1",
      conversationId: "cv_1",
      startUtc: last.startUtc,
    });

    expect(mocks.createSessionBooking).toHaveBeenCalledWith(
      expect.objectContaining({ startUtc: last.startUtc, requireOffer: true })
    );
    expect(turn.ok).toBe(true);
    expect(turn.text).toContain("16:20");
  });
});
