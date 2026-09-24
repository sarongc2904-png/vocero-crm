/**
 * Escenarios del Laboratorio.
 *
 * Los tipos son globales, pero los guiones son configurables por organización.
 * Nunca deben contener fixtures de una industria concreta.
 */

export const SCENARIO_KEYS = [
  "comprador_decidido",
  "pregunton_precios",
  "cliente_enojado",
  "fuera_de_kb",
  "pide_humano",
  "errores_modismos",
] as const;

export type ScenarioKey = (typeof SCENARIO_KEYS)[number];

export type Persona = {
  key: ScenarioKey;
  label: string;
  description: string;
  phone: string;
  contactName: string;
  script: string[];
};

export type ScenarioScripts = Partial<Record<ScenarioKey, string[]>>;

const META: Record<
  ScenarioKey,
  Omit<Persona, "script">
> = {
  comprador_decidido: {
    key: "comprador_decidido",
    label: "Comprador decidido",
    description: "Sabe lo que quiere y va directo a comprar o contratar.",
    phone: "5210000000001",
    contactName: "[Prueba] Comprador decidido",
  },
  pregunton_precios: {
    key: "pregunton_precios",
    label: "Preguntón de precios",
    description: "Pregunta opciones, precios y condiciones antes de decidir.",
    phone: "5210000000002",
    contactName: "[Prueba] Preguntón de precios",
  },
  cliente_enojado: {
    key: "cliente_enojado",
    label: "Cliente enojado",
    description: "Llega molesto por un problema y exige solución.",
    phone: "5210000000003",
    contactName: "[Prueba] Cliente enojado",
  },
  fuera_de_kb: {
    key: "fuera_de_kb",
    label: "Pregunta fuera del conocimiento",
    description: "Pregunta algo que el knowledge base no cubre.",
    phone: "5210000000004",
    contactName: "[Prueba] Fuera del conocimiento",
  },
  pide_humano: {
    key: "pide_humano",
    label: "Pide un humano",
    description: "Solicita expresamente atención de una persona.",
    phone: "5210000000005",
    contactName: "[Prueba] Pide humano",
  },
  errores_modismos: {
    key: "errores_modismos",
    label: "Errores y modismos",
    description: "Escribe con faltas de ortografía y lenguaje coloquial.",
    phone: "5210000000006",
    contactName: "[Prueba] Errores y modismos",
  },
};

export const DEFAULT_SCENARIO_SCRIPTS: Record<ScenarioKey, string[]> = {
  comprador_decidido: [
    "Hola, me interesa lo que ofrecen.",
    "Ya revisé la información y quiero contratar o comprar la opción que más me convenga.",
    "¿Cuánto cuesta y qué necesito para empezar?",
    "Perfecto, quiero avanzar hoy. ¿Cuál es el siguiente paso?",
  ],
  pregunton_precios: [
    "Hola, ¿qué opciones manejan?",
    "¿Cuánto cuesta cada opción?",
    "¿Qué incluye cada una?",
    "¿Tienen algún descuento o condición especial?",
    "Gracias, lo voy a revisar.",
  ],
  cliente_enojado: [
    "Hola, necesito ayuda con algo que contraté o compré con ustedes.",
    "Estoy molesto porque tuve un problema y necesito una solución.",
    "¿Me pueden ayudar o comunicarme con alguien que lo resuelva?",
  ],
  fuera_de_kb: [
    "Hola, tengo una pregunta.",
    "Quiero saber algo que no aparece en la información que tienen publicada.",
    "Si no tienen ese dato, prefiero que me lo confirme una persona.",
  ],
  pide_humano: [
    "Hola.",
    "Tengo una consulta importante.",
    "Prefiero hablar con una persona, ¿me pueden comunicar con un asesor?",
    "Gracias.",
  ],
  errores_modismos: [
    "ola, me interesa lo q ofrecen",
    "me dice cuanto sale y q incluye?",
    "y como le ago para contratarlo o comprarlo?",
    "va, gracias",
  ],
};

export function buildPersonas(input?: {
  enabledScenarios?: string[] | null;
  scenarioScripts?: Record<string, string[]> | null;
}): Persona[] {
  const enabled = new Set(
    input?.enabledScenarios?.filter((key): key is ScenarioKey =>
      SCENARIO_KEYS.includes(key as ScenarioKey)
    ) ?? SCENARIO_KEYS
  );

  return SCENARIO_KEYS.filter((key) => enabled.has(key)).map((key) => {
    const configured = input?.scenarioScripts?.[key];
    const script =
      Array.isArray(configured) && configured.some((line) => line.trim())
        ? configured.map((line) => line.trim()).filter(Boolean)
        : DEFAULT_SCENARIO_SCRIPTS[key];

    return {
      ...META[key],
      script,
    };
  });
}

export const PERSONAS = buildPersonas();

export const PERSONA_LABELS: Record<string, string> = Object.fromEntries(
  SCENARIO_KEYS.map((key) => [key, META[key].label])
);
