import { z } from "zod";
import { apiError, parseBody, withOrgPermissions } from "@/lib/api";
import {
  parseGoogleMapsUrl,
  resolveFromText,
  resolveGoogleMapsShareLink,
} from "@/server/maps/resolve-location";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  query: z.string().trim().min(3).max(1000),
});

/**
 * Resuelve ubicaciones sin depender de Google Geocoding API de pago:
 * - coordenadas directas;
 * - URLs de Google Maps que ya contienen coordenadas;
 * - enlaces compartidos/cortos de Google Maps siguiendo redirecciones;
 * - Plus Codes completos (Open Location Code) decodificados localmente.
 *
 * Los Plus Codes cortos (ej. FFW7+Q5 Nuevo Laredo) necesitan una referencia
 * geográfica externa y, por diseño, no se intentan adivinar.
 */
export const POST = withOrgPermissions(
  ["conversations.reply"],
  async (_session, req: Request) => {
    const body = await parseBody(req, bodySchema);
    if (!body.ok) return body.response;

    const query = body.data.query.trim();
    const local = resolveFromText(query);
    if (local) return Response.json(local);

    if (parseGoogleMapsUrl(query)) {
      try {
        const resolved = await resolveGoogleMapsShareLink(query);
        if (resolved) return Response.json(resolved);
      } catch (error) {
        console.warn(
          "[maps] no se pudo resolver enlace compartido:",
          error instanceof Error ? error.message : String(error)
        );
        return apiError(
          503,
          "maps_link_unavailable",
          "No se pudo abrir el enlace compartido de Google Maps en este momento"
        );
      }
    }

    return apiError(
      422,
      "location_not_found",
      "No se pudo resolver la ubicación. Comparte un enlace de Google Maps, coordenadas o un Plus Code completo."
    );
  }
);
