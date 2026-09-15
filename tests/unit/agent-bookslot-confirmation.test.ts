import { describe, expect, it, vi } from "vitest";

/**
 * Fase 1 — bug de agenda, Fix A: la confirmación de `bookSlot` ya NO acepta
 * texto libre del modelo para la fecha/hora (el campo `confirmation` se
 * eliminó de la firma). Esto reproduce el caso de producción: el cliente
 * pedía "sábado", el modelo escribía "sábado" en su reply, y el booking real
 * caía otro día — con el fix, el texto SIEMPRE sale de `result.label`, que es
 * lo que de verdad quedó agendado.
 */

const createSessionBooking = vi.fn();

vi.mock("@/server/agenda/service", () => ({
  BookingError: class BookingError extends Error {
    code: string;
    slots: unknown[];
    constructor(code: string, message: string, slots: unknown[] = []) {
      super(message);
      this.code = code;
      this.slots = slots;
    }
  },
  createSessionBooking: (...args: unknown[]) => createSessionBooking(...args),
}));

describe("bookSlot — la fecha/hora de la confirmación es SIEMPRE la real, nunca texto libre", () => {
  it("el booking real cae el jueves 17: el texto dice jueves 17, sin importar qué reply mandara el modelo", async () => {
    createSessionBooking.mockResolvedValueOnce({
      booking: { durationMinutes: 30 },
      meetingLink: null,
      linkPending: false,
      label: "jue 17 sep, 09:00",
    });

    const { bookSlot } = await import("@/server/agenda/agent");
    // El tipo de `bookSlot` ya no acepta `confirmation`: no hay forma de que
    // un llamador (el pipeline) le pase texto libre del modelo para la fecha.
    const turn = await bookSlot({
      organizationId: "org_1",
      conversationId: "cv_1",
      startUtc: "2026-09-17T15:00:00.000Z",
    });

    expect(turn.ok).toBe(true);
    expect(turn.text).toContain("jue 17 sep, 09:00");
    // Nunca debe colarse un día distinto inventado por nadie más.
    expect(turn.text).not.toMatch(/sábado|sabado/i);
  });

  it("incluye el enlace para agregar la cita al calendario del cliente, con la fecha real", async () => {
    createSessionBooking.mockResolvedValueOnce({
      booking: { durationMinutes: 45 },
      meetingLink: "https://meet.example.com/xyz",
      linkPending: false,
      label: "sáb 19 sep, 10:00",
    });

    const { bookSlot } = await import("@/server/agenda/agent");
    const turn = await bookSlot({
      organizationId: "org_1",
      conversationId: "cv_1",
      startUtc: "2026-09-19T16:00:00.000Z",
    });

    expect(turn.text).toContain("sáb 19 sep, 10:00");
    expect(turn.text).toContain("Agrega la cita a tu calendario");
    expect(turn.text).toContain("calendar.google.com");
  });
});
