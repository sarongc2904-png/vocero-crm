/**
 * Patrón de RESPALDO de intención de escalado (FR-022). Se evalúa sobre el
 * mensaje del cliente ANTES del LLM: si matchea, el handoff ocurre aunque el
 * modelo no lo detecte. Diseñado para exigir un verbo de contacto cerca del
 * objeto humano — "somos 4 personas" NO matchea (test unitario).
 */
export const HANDOFF_BACKUP_REGEX =
  /(hablar|comunicar|contactar)[\s\S]{0,40}?(asesor|humano|persona|alguien)|un asesor|atenci[oó]n humana|prefier[oa][\s\S]{0,60}?(asesor|humano|persona|alguien)|(?:que\s+)?me\s+(?:lo\s+)?(?:confirme|revise|atienda)[\s\S]{0,35}?(asesor|humano|persona|alguien)/i;

export function matchesHandoffIntent(text: string): boolean {
  return HANDOFF_BACKUP_REGEX.test(text);
}

function normalizeHandoffText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Un handoff sugerido por el modelo necesita una causa observable. Las reglas
 * libres del negocio no conceden permiso global para escalar: deben coincidir
 * con una categoría explícita presente también en el mensaje actual.
 */
export function matchesConfiguredEscalation(
  text: string,
  escalationRules: string | null | undefined
): boolean {
  if (!escalationRules?.trim()) return false;

  const message = normalizeHandoffText(text);
  const rules = normalizeHandoffText(escalationRules);

  const categories = [
    {
      rule: /quej|reclam|molest|enoj|inconform/,
      message: /quej|reclam|molest|enoj|inconform/,
    },
    {
      rule: /urgenc|emergenc|riesgo|seguridad|peligro/,
      message: /urgenc|emergenc|riesgo|peligro|accidente/,
    },
    {
      rule: /pago|cobro|factur|reembolso|devolu/,
      message: /pago|cobro|factur|reembolso|devolu/,
    },
    {
      rule: /descuento|negoci|promocion especial/,
      message: /descuento|negoci|promocion especial/,
    },
  ] as const;

  return categories.some(
    (category) => category.rule.test(rules) && category.message.test(message)
  );
}

export function shouldAllowModelHandoff(
  text: string,
  escalationRules: string | null | undefined
): boolean {
  return (
    matchesHandoffIntent(text) ||
    matchesConfiguredEscalation(text, escalationRules)
  );
}


/**
 * ¿El cliente formuló una petición concreta (pregunta o intención explícita)?
 * Un saludo o agradecimiento suelto no lo es.
 */
function isConcreteRequest(message: string): boolean {
  return (
    message.includes("?") ||
    /\b(que|cual|cuales|cuanto|cuanta|cuantos|como|donde|cuando|tienen|hay|manejan|incluye|quiero|quisiera|necesito|me interesa|me puede|me pueden|podria|precio|costo|descuento|promocion|contratar|comprar|agendar)\b/.test(
      message
    )
  );
}

/** Temas comerciales reconocibles para nombrar la pregunta del cliente. */
const REQUEST_TOPICS: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern: /precio|costo|cuesta|cuestan|tarifa|cotiza|cuanto (sale|salen|vale|valen|cobra)/,
    label: "el precio",
  },
  { pattern: /incluye|incluyen|incluido/, label: "lo que incluye" },
  {
    pattern: /requisito|empezar|comenzar|iniciar|necesito para/,
    label: "los requisitos para empezar",
  },
  { pattern: /descuento|promocion|promo\b/, label: "descuentos o promociones" },
];

/** El perfil pide tutear sólo si su tono lo dice; por defecto se usa usted. */
function prefersInformalRegister(tone: string | null | undefined): boolean {
  if (!tone) return false;
  return /tute|\bde tu\b|informal/.test(normalizeHandoffText(tone));
}

/**
 * Respuesta segura cuando el modelo insiste en escalar pero el backend no
 * autoriza el handoff (último recurso: el reintento ya excluye handoff y sólo
 * se llega aquí si ese reintento falla).
 *
 * Ante una petición concreta nombra el tema preguntado, admite que no hay un
 * dato confirmado y ofrece un asesor de forma explícita; nunca vuelve a
 * preguntar "qué información necesita" cuando el cliente ya lo dijo. Respeta
 * el registro (tú/usted) del tono configurado.
 */
export function rejectedHandoffFallback(
  text: string,
  tone?: string | null
): string {
  const message = normalizeHandoffText(text);
  const informal = prefersInformalRegister(tone);

  const expressesProblem =
    /molest|enoj|frustr|quej|reclam|inconform|problema|no funciona|no sirve|necesito una solucion|quiero una solucion/.test(
      message
    );

  if (expressesProblem) {
    return informal
      ? "Entiendo que tuviste un problema y quiero ayudarte a resolverlo. ¿Me cuentas qué ocurrió?"
      : "Entiendo que tuvo un problema y quiero ayudarle a resolverlo. ¿Puede contarme qué ocurrió?";
  }

  if (isConcreteRequest(message)) {
    const topics = REQUEST_TOPICS.filter((topic) => topic.pattern.test(message))
      .map((topic) => topic.label)
      .slice(0, 2);
    const subject =
      topics.length > 0 ? topics.join(" y ") : informal ? "tu pregunta" : "su pregunta";
    return informal
      ? `Sobre ${subject}, por ahora no tengo información confirmada para compartirte por este medio. Si quieres que un asesor te lo confirme, solo escríbeme que quieres hablar con un asesor.`
      : `Sobre ${subject}, por ahora no tengo información confirmada para compartirle por este medio. Si desea que un asesor se lo confirme, solo escríbame que quiere hablar con un asesor.`;
  }

  return informal ? "Con gusto. ¿En qué te puedo ayudar?" : "Con gusto. ¿En qué le puedo ayudar?";
}
