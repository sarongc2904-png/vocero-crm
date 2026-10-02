import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  query: z.string().trim().min(3).max(500),
});

type GoogleGeocodeResponse = {
  status?: string;
  error_message?: string;
  results?: Array<{
    formatted_address?: string;
    geometry?: {
      location?: {
        lat?: number;
        lng?: number;
      };
    };
  }>;
};

/**
 * Resuelve direcciones o Plus Codes con Google Maps Geocoding API.
 * La API key vive solo en servidor y nunca se expone al navegador.
 */
export const POST = withOrgPermissions(
  ["conversations.reply"],
  async (_session, req: Request) => {
    const body = await parseBody(req, bodySchema);
    if (!body.ok) return body.response;

    const apiKey = getEnv().GOOGLE_MAPS_API_KEY?.trim();
    if (!apiKey) {
      return apiError(
        501,
        "maps_not_configured",
        "La resolución de Plus Codes no está configurada"
      );
    }

    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", body.data.query);
    url.searchParams.set("key", apiKey);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
    } catch {
      return apiError(
        503,
        "maps_unavailable",
        "Google Maps no está disponible en este momento"
      );
    }

    if (!response.ok) {
      return apiError(
        503,
        "maps_unavailable",
        "Google Maps no está disponible en este momento"
      );
    }

    const data = (await response.json().catch(() => null)) as
      | GoogleGeocodeResponse
      | null;

    if (data?.status === "ZERO_RESULTS" || !data?.results?.length) {
      return apiError(
        422,
        "location_not_found",
        "No se pudo encontrar esa ubicación o Plus Code"
      );
    }

    if (data.status !== "OK") {
      console.warn("[maps] geocoding rechazado:", data.status, data.error_message ?? "");
      return apiError(
        data.status === "OVER_QUERY_LIMIT" ? 503 : 422,
        "maps_geocode_failed",
        data.status === "REQUEST_DENIED"
          ? "Google Maps rechazó la solicitud; revisa la API key y Geocoding API"
          : "No se pudo resolver esa ubicación"
      );
    }

    const first = data.results[0];
    if (!first) {
      return apiError(
        422,
        "location_not_found",
        "Google Maps no devolvió resultados para esa ubicación"
      );
    }

    const latitude = first.geometry?.location?.lat;
    const longitude = first.geometry?.location?.lng;

    if (
      typeof latitude !== "number" ||
      !Number.isFinite(latitude) ||
      typeof longitude !== "number" ||
      !Number.isFinite(longitude)
    ) {
      return apiError(
        422,
        "location_not_found",
        "Google Maps no devolvió coordenadas para esa ubicación"
      );
    }

    return Response.json({
      latitude,
      longitude,
      formattedAddress: first.formatted_address ?? null,
    });
  }
);
