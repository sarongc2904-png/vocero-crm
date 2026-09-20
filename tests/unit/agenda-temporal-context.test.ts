import { describe, expect, it } from "vitest";
import { dayLabelInTz } from "@/lib/time/slots";
import { formatSlotBlocks } from "@/server/agenda/agent";
import { filterFreeSlots } from "@/server/agenda/availability";
import {
  currentOffers,
  findOffered,
  mapaDeHuecosParaModelo,
  type OfferedSlot,
} from "@/server/agenda/offers";
import { spreadByDay } from "@/server/agenda/spread";

const MX = "America/Mexico_City";
const NOW = new Date("2026-09-19T18:43:00-06:00");

const candidate = (wallClock: string) => {
  const start = new Date(`${wallClock}:00-06:00`);
  return {
    startUtc: start.toISOString(),
    endUtc: new Date(start.getTime() + 40 * 60_000).toISOString(),
  };
};

describe("regresión 2026-09-19 18:43 — contexto temporal de agenda", () => {
  it("elimina los tres slots pasados y renderiza únicamente el domingo real", () => {
    const slots = [
      candidate("2026-09-19T13:40"),
      candidate("2026-09-19T14:20"),
      candidate("2026-09-19T15:00"),
      candidate("2026-09-20T09:00"),
      candidate("2026-09-20T09:40"),
      candidate("2026-09-20T10:20"),
    ];
    const valid = filterFreeSlots(slots, [], {
      now: NOW,
      minNoticeHours: 0,
      timezone: MX,
    });
    const rendered = formatSlotBlocks(
      spreadByDay(valid, { timezone: MX, limit: 10, perDay: 10, now: NOW }),
      MX,
      NOW
    );

    expect(valid.map((slot) => slot.startUtc)).toEqual([
      "2026-09-20T15:00:00.000Z",
      "2026-09-20T15:40:00.000Z",
      "2026-09-20T16:20:00.000Z",
    ]);
    expect(rendered).toBe(
      "Mañana domingo, 20 de septiembre\n• 09:00\n• 09:40\n• 10:20"
    );
    expect(rendered).not.toMatch(/13:40|14:20|15:00|jueves|17 de septiembre/);
  });

  it("acepta justo antes, pero rechaza exactamente al inicio y después", () => {
    const slot = candidate("2026-09-20T09:00");
    const filterAt = (now: string) =>
      filterFreeSlots([slot], [], {
        now: new Date(now),
        minNoticeHours: 0,
        timezone: MX,
      });

    expect(filterAt("2026-09-20T08:59:59.999-06:00")).toHaveLength(1);
    expect(filterAt("2026-09-20T09:00:00.000-06:00")).toHaveLength(0);
    expect(filterAt("2026-09-20T09:00:00.001-06:00")).toHaveLength(0);
  });

  it("recalcula hoy/mañana al cruzar 23:59 → 00:00 en la zona del tenant", () => {
    const slot = "2026-09-20T06:01:00.000Z";
    expect(dayLabelInTz(slot, MX, new Date("2026-09-20T05:59:00.000Z"))).toMatch(
      /^mañana domingo/
    );
    expect(dayLabelInTz(slot, MX, new Date("2026-09-20T06:00:00.000Z"))).toMatch(
      /^hoy domingo/
    );
  });

  it("interpreta el UTC almacenado con la zona de cada tenant", () => {
    const storedUtc = "2026-09-20T06:30:00.000Z";
    const now = new Date("2026-09-19T23:30:00.000Z");
    const base: OfferedSlot[] = [{ startUtc: storedUtc, label: "texto viejo" }];
    const tenantA = currentOffers(base, { now, minNoticeHours: 0, timezone: MX });
    const tenantB = currentOffers(base, {
      now,
      minNoticeHours: 0,
      timezone: "Asia/Tokyo",
    });

    expect(tenantA[0]!.label).toMatch(/^mañana domingo, 20 de septiembre a las 00:30$/);
    expect(tenantB[0]!.label).toMatch(/^hoy domingo, 20 de septiembre a las 15:30$/);
  });

  it("no conserva un reloj de arranque ni etiquetas relativas entre días", () => {
    const persisted: OfferedSlot[] = [
      {
        startUtc: "2026-09-17T19:40:00.000Z",
        label: "hoy jueves, 17 de septiembre a las 13:40",
      },
      {
        startUtc: "2026-09-20T15:00:00.000Z",
        label: "domingo 20 de septiembre a las 09:00",
      },
    ];

    expect(
      currentOffers(persisted, {
        now: new Date("2026-09-17T12:00:00-06:00"),
        minNoticeHours: 0,
        timezone: MX,
      })
    ).toHaveLength(2);

    const retriedDaysLater = currentOffers(persisted, {
      now: NOW,
      minNoticeHours: 0,
      timezone: MX,
    });
    expect(retriedDaysLater).toEqual([
      {
        startUtc: "2026-09-20T15:00:00.000Z",
        label: "mañana domingo, 20 de septiembre a las 09:00",
      },
    ]);
    const modelContext = mapaDeHuecosParaModelo(retriedDaysLater)!;
    expect(modelContext).toContain("mañana domingo, 20 de septiembre a las 09:00");
    expect(modelContext).not.toContain("hoy jueves");
    expect(modelContext).not.toContain("2026-09-17T19:40:00.000Z");
  });

  it("una oferta de ayer ya no es reservable hoy", () => {
    const yesterday: OfferedSlot[] = [
      {
        startUtc: "2026-09-18T16:00:00.000Z",
        label: "ayer",
        serviceId: "svc_1",
        professionalId: "pro_1",
      },
    ];
    const current = currentOffers(yesterday, {
      now: NOW,
      minNoticeHours: 0,
      timezone: MX,
    });
    expect(findOffered(current, yesterday[0]!.startUtc)).toBeNull();
  });
});
