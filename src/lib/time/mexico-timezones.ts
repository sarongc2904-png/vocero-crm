/**
 * Zonas mexicanas canónicas de IANA tzdata (zone.tab).
 *
 * Las etiquetas describen regiones, no offsets: los offsets cambian con las
 * reglas legales de horario estacional y siempre los resuelve `Intl`.
 */
export const MEXICO_TIMEZONES = [
  { value: "America/Tijuana", label: "Baja California (Tijuana)" },
  { value: "America/Hermosillo", label: "Sonora (Hermosillo)" },
  { value: "America/Ciudad_Juarez", label: "Chihuahua frontera oeste (Ciudad Juárez)" },
  { value: "America/Ojinaga", label: "Chihuahua frontera este (Ojinaga)" },
  { value: "America/Chihuahua", label: "Chihuahua (excepto frontera)" },
  { value: "America/Mazatlan", label: "Pacífico (Baja California Sur, Sinaloa y Nayarit)" },
  { value: "America/Bahia_Banderas", label: "Bahía de Banderas" },
  {
    value: "America/Matamoros",
    label: "Tamaulipas frontera (Nuevo Laredo, Reynosa, Matamoros)",
  },
  { value: "America/Monterrey", label: "Noreste de México" },
  { value: "America/Mexico_City", label: "Centro de México" },
  { value: "America/Merida", label: "Península de Yucatán (Mérida)" },
  { value: "America/Cancun", label: "Quintana Roo (Cancún)" },
] as const;

export type MexicoTimeZone = (typeof MEXICO_TIMEZONES)[number]["value"];

const MEXICO_TIMEZONE_SET = new Set<string>(
  MEXICO_TIMEZONES.map((option) => option.value)
);

export function isMexicoTimeZone(value: string): value is MexicoTimeZone {
  return MEXICO_TIMEZONE_SET.has(value);
}
