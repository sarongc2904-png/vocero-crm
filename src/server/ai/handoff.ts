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
 * Respuesta segura cuando el modelo insiste en escalar pero el backend no
 * autoriza el handoff. Reconoce una queja o frustración sin escalar por sí sola.
 */
export function rejectedHandoffFallback(text: string): string {
  const message = normalizeHandoffText(text);

  const expressesProblem =
    /molest|enoj|frustr|quej|reclam|inconform|problema|no funciona|no sirve|necesito una solucion|quiero una solucion/.test(
      message
    );

  if (expressesProblem) {
    return "Entiendo que tuvo un problema y quiero ayudarle a resolverlo. ¿Puede contarme qué ocurrió?";
  }

  return "Claro, puedo ayudarte con eso. Dime qué información necesitas.";
}
