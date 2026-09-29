import { apiError, withOrgRoles } from "@/lib/api";
import { getDb } from "@/lib/db";
import {
  DEMO_SEED_BLOCKER_LABEL,
  getDemoSeedBlockers,
  seedDemo,
} from "@/server/seed/demo";

export const dynamic = "force-dynamic";

/**
 * Carga el negocio demo (FR-075).
 *
 * ONB-1 — Esta ruta era destructiva sin decirlo:
 *   - el guard solo miraba los CONTACTOS, así que una organización con su base
 *     de conocimiento, sus corridas del Laboratorio y su agente ya configurados
 *     pero sin contactos pasaba el filtro, y el seed borraba todo eso;
 *   - no pedía ninguna confirmación: un clic (o un `fetch` perdido) bastaba;
 *   - el error decía "ya hay datos" sin explicar qué se iba a destruir.
 *
 * Ahora: se calcula la lista exacta de lo que se perdería, se exige
 * `confirm: true` explícito en el cuerpo, y si algo se perdería la respuesta
 * 409 enumera QUÉ es. Un cliente real nunca pierde su conocimiento por cargar
 * una demo. La recarga destructiva sigue existiendo solo por script
 * (`pnpm seed:demo --force`), donde alguien lo pidió a propósito.
 */
export const POST = withOrgRoles(
  ["owner", "admin"],
  async (session, request: Request) => {
  const db = getDb();

  const blockers = await getDemoSeedBlockers(db, session.organizationId);
  if (blockers.length > 0) {
    return apiError(
      409,
      "not_empty",
      `No se cargó la demo: esta organización ya tiene ${blockers
        .map((blocker) => DEMO_SEED_BLOCKER_LABEL[blocker])
        .join(", ")}. La demo reemplazaría esos datos, así que solo se carga en una organización vacía.`
    );
  }

  /**
   * Confirmación explícita. Es deliberadamente redundante con el guard: el
   * guard protege los datos existentes, esto protege del descuido (un `fetch`
   * sin cuerpo ya no basta para escribir 8 contactos falsos y reemplazar la
   * identidad del agente).
   */
  const body = await request.json().catch(() => null);
  if (!body || (body as { confirm?: unknown }).confirm !== true) {
    return apiError(
      400,
      "confirmation_required",
      "Falta la confirmación explícita para cargar la demo (confirm: true). " +
        "La demo crea 8 contactos de ejemplo, agrega conocimiento de ejemplo, " +
        "una corrida del Laboratorio y reemplaza la identidad del agente."
    );
  }

  const result = await seedDemo(db, session.organizationId);
  return Response.json({ ok: true, ...result });
});
