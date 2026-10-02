import { describe, expect, it, vi } from "vitest";
import {
  decodeFullPlusCode,
  parseCoordinates,
  resolveGoogleMapsShareLink,
} from "@/server/maps/resolve-location";

describe("resolución de ubicaciones sin API de pago", () => {
  it("extrae coordenadas de enlaces directos de Google Maps", () => {
    expect(
      parseCoordinates("https://www.google.com/maps/place/X/@27.48187,-99.50516,17z")
    ).toEqual({ latitude: 27.48187, longitude: -99.50516 });

    expect(
      parseCoordinates("https://www.google.com/maps/place/X/data=!3d27.48187!4d-99.50516")
    ).toEqual({ latitude: 27.48187, longitude: -99.50516 });
  });

  it("prefiere las coordenadas exactas del lugar sobre el viewport del mapa", () => {
    expect(
      parseCoordinates(
        "https://www.google.com/maps/place/Elektra/@27.494449,-99.549372,17z/data=!4m6!3m5!1s0x0:0x0!8m2!3d27.497001!4d-99.546002!16s%2Fg%2F1"
      )
    ).toEqual({ latitude: 27.497001, longitude: -99.546002 });
  });

  it("decodifica un Plus Code completo localmente", () => {
    const result = decodeFullPlusCode("849VCWC8+R9");
    expect(result).not.toBeNull();
    expect(result!.latitude).toBeCloseTo(37.42206, 4);
    expect(result!.longitude).toBeCloseTo(-122.08406, 4);
  });

  it("sigue un enlace compartido corto y extrae coordenadas de la redirección", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: {
          location:
            "https://www.google.com/maps/place/X/@27.48187,-99.50516,17z",
        },
      })
    );

    const result = await resolveGoogleMapsShareLink(
      "https://maps.app.goo.gl/abc123",
      fetchMock as unknown as typeof fetch
    );

    expect(result).toEqual({ latitude: 27.48187, longitude: -99.50516 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rechaza hosts ajenos a Google Maps", async () => {
    const fetchMock = vi.fn();
    const result = await resolveGoogleMapsShareLink(
      "https://example.com/maps/27,-99",
      fetchMock as unknown as typeof fetch
    );
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
