/**
 * 0037 — Si esta instancia tiene cotizaciones.
 *
 * Mismo trato que la agenda (ADR-002) y la atribución: el código viaja en
 * `main` y lo que decide si EXISTE para el usuario es una variable de
 * despliegue, apagada por defecto. Sin ella, toda la superficie (API del bot,
 * pantallas y la ruta pública /p/[token]) responde 404.
 *
 * La migración se aplica siempre: unas tablas vacías son inertes.
 */

/** Valores que cuentan como "encendida". Cualquier otra cosa, apagada. */
const ON_VALUES = new Set(["on", "1", "true", "si", "sí", "yes"]);

export function parseCotizacionesFlag(raw: string | undefined): boolean {
  return ON_VALUES.has((raw ?? "").trim().toLowerCase());
}

/**
 * Se lee de `process.env` directo, igual que `agendaEnabled()`: preguntar si
 * una feature existe no puede depender de que TODO el entorno valide.
 * `COTIZACIONES` está declarada en `lib/env.ts`, donde vive su documentación.
 */
export function quotesEnabled(): boolean {
  return parseCotizacionesFlag(process.env.COTIZACIONES);
}

/**
 * 404 y no 403: con la bandera apagada el endpoint no existe en esta
 * instancia, y no hay nada que revelar sobre él.
 */
export function quotesDisabledResponse(): Response {
  return new Response(null, { status: 404 });
}
