import type { schema } from "@/lib/db";

type AgentProfile = typeof schema.agentProfile.$inferSelect;
type KbEntry = typeof schema.kbEntry.$inferSelect;

/** Marcador del prompt del juez: el ai-mock lo usa para despachar veredictos. */
export const JUDGE_MARKER = "[JUEZ]";

export function renderKb(entries: KbEntry[]): string {
  if (entries.length === 0) return "(knowledge base vacío)";
  return entries
    .map((e) =>
      e.kind === "qa"
        ? `P: ${e.question}\nR: ${e.answer}`
        : (e.content ?? "")
    )
    .filter(Boolean)
    .join("\n\n");
}

/**
 * System prompt del agente (v1: inyecta el KB completo — el límite se
 * documenta con el contador de tamaño en la UI).
 */
export function buildAgentSystemPrompt(input: {
  profile: AgentProfile;
  kb: KbEntry[];
  stages: { name: string }[];
  /**
   * 015 — ¿esta instancia tiene agenda? Apagada, el prompt no gasta ni un
   * token en hablar de horarios: la agenda no existe aquí.
   */
  agenda?: boolean;
  /**
   * Ancla de fecha para resolver "mañana"/"el viernes"/etc. Solo se usa con
   * agenda=true. Sin esto el modelo no tiene forma de saber qué día es hoy y
   * `offer_slots.day` sale mal calculado (o no sale) siempre.
   */
  today?: { iso: string; label: string };
  /**
   * Fase 1 — verdad de horario para la fecha que el propio BACKEND detectó en
   * el último mensaje del cliente (`resolveTargetDate`, no el LLM). Cuando
   * existe, es un HECHO — el modelo no puede contradecirlo ni inventar otro
   * horario para ese día. Es la corrección al bug "domingo estamos cerrados"
   * dicho sobre un domingo configurado como abierto: antes el modelo no tenía
   * NINGÚN dato de `weeklyHours`, solo la fecha de hoy — respondía de
   * memoria/entrenamiento, nunca de la configuración real del negocio.
   */
  businessFact?: {
    targetDate: string;
    dayOfWeekLabel: string;
    businessOpen: boolean;
    businessHours: string;
    timezone: string;
  };
}): string {
  const { profile } = input;
  const stageNames = input.stages.map((s) => s.name).join(" | ");
  const agendaLines = input.agenda
    ? [
        '- {"action":"offer_slots","day":"<YYYY-MM-DD, opcional>","reply":"..."} — ofrecer horarios para agendar. Si el cliente pidió un día concreto ("mañana", "el viernes", una fecha), calcula ESE día como YYYY-MM-DD usando la fecha de hoy de abajo y ponlo en `day`; si no mencionó ningún día, omite el campo. `reply` es solo la frase de entrada — los horarios los pone el sistema. Si abajo hay un HECHO DE HORARIO con `targetDate`, ESA es la fecha — tu `day` se ignora si no coincide, así que ni te molestes en recalcularla distinto.',
        '- {"action":"book_slot","startUtc":"<uno de los horarios que el sistema ofreció, en ISO UTC>","reply":"..."} — agendar el horario que el cliente eligió.',
      ]
    : [];
  const agendaRules = input.agenda
    ? [
        input.today
          ? `- Hoy es ${input.today.label} (fecha ISO ${input.today.iso}). Usa esta fecha como ancla para calcular cualquier día que el cliente mencione.`
          : null,
        input.businessFact
          ? `- HECHO DE HORARIO (verdad del sistema, no la contradigas ni la reformules): para targetDate=${input.businessFact.targetDate} (${input.businessFact.dayOfWeekLabel}, zona ${input.businessFact.timezone}) el negocio está ${input.businessFact.businessOpen ? `ABIERTO, horario ${input.businessFact.businessHours}` : "CERRADO"}. Si el cliente pregunta si se trabaja ese día, responde ESTO tal cual — nunca digas "cerrado" si dice ABIERTO, ni inventes un horario distinto al indicado.`
          : "- Si te preguntan si un día está abierto o cerrado y NO tienes un HECHO DE HORARIO para esa fecha aquí arriba, NO lo afirmes de memoria: usa offer_slots para averiguarlo, o dile que lo confirmas.",
        "- NUNCA escribas tú los horarios ni los inventes: usa offer_slots y el sistema pega los reales.",
        "- NUNCA nombres en tu `reply` un día distinto al que pediste en `day` (o al más próximo, si no pediste ninguno): el sistema puede no tener nada ese día y te lo dirá — no prometas un día antes de saber que sí hay.",
        "- book_slot solo acepta un horario que el sistema ofreció antes en ESTA conversación. Si el cliente pide otro, vuelve a ofrecer con offer_slots.",
        "- Al confirmar una cita, la fecha/hora exactas las pone el sistema en su propio texto — tu `reply` en book_slot es solo tono/cierre, no repitas ni inventes la fecha ahí.",
        "- Si el cliente quiere CANCELAR una cita → handoff: esa decisión no es tuya.",
      ].filter((line): line is string => line !== null)
    : [];
  return [
    `Eres "${profile.name}", el asistente de WhatsApp de este negocio. Respondes SIEMPRE en español neutro, con mensajes breves y naturales para chat.`,
    profile.tone ? `Tono: ${profile.tone}` : null,
    profile.instructions ? `Instrucciones del negocio:\n${profile.instructions}` : null,
    profile.escalationRules
      ? `Reglas de escalado a humano:\n${profile.escalationRules}`
      : null,
    profile.greeting ? `Saludo sugerido para conversaciones nuevas: ${profile.greeting}` : null,
    `CONOCIMIENTO DEL NEGOCIO (tu única fuente de verdad; si algo no está aquí, NO lo inventes — di que lo confirmarás con el equipo o escala):\n${renderKb(input.kb)}`,
    `Etapas del pipeline disponibles: ${stageNames}`,
    [
      "En cada turno respondes ÚNICAMENTE un objeto JSON con UNA acción:",
      '- {"action":"none"} — no responder nada.',
      '- {"action":"reply","text":"..."} — responder al cliente.',
      '- {"action":"update_lead","note":"...","reply":"..."} — guardar una nota del lead (reply opcional).',
      '- {"action":"move_stage","stage":"<nombre exacto de etapa>","reply":"..."} — mover el lead (reply opcional).',
      '- {"action":"handoff","reason":"...","farewell":"..."} — escalar a un humano (farewell opcional para despedirte).',
      ...agendaLines,
      "Reglas duras:",
      "- Si el cliente pide hablar con una persona/humano/asesor → handoff.",
      "- Si la pregunta NO está cubierta por el conocimiento → NO inventes: responde que lo confirmarás o escala.",
      "- Si detectas intención clara de compra → move_stage a la etapa de interesados y confirma al cliente.",
      ...agendaRules,
      "- JSON puro, sin markdown ni texto adicional.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Prompt del juez del Laboratorio: UNA llamada por conversación (FR-032).
 *
 * Causa raíz de un falso negativo reportado (auditoría del evaluador): el
 * prompt anterior decía "si el agente respondió sobre un tema que NO está en
 * el conocimiento → hallazgo fuera_de_kb" — eso confunde el EVENTO (el
 * cliente preguntó algo fuera del KB) con el RESULTADO (si el agente lo
 * manejó bien o mal). Un evento difícil (pregunta fuera de KB, cliente
 * enojado) no es automáticamente un error: lo es solo si el COMPORTAMIENTO
 * del agente ante ese evento fue incorrecto. El prompt de abajo separa
 * explícitamente evento/comportamiento/resultado y exige que cada hallazgo
 * venga con `severity` + `reason` — obliga al juez a justificar la falla en
 * vez de marcarla solo porque el evento ocurrió.
 */
export function buildJudgePrompt(input: {
  persona: string;
  transcript: { role: "cliente" | "agente"; text: string }[];
  kbText: string;
  behaviorText: string;
}): { system: string; user: string } {
  const system = [
    `${JUDGE_MARKER} Eres un evaluador de calidad independiente de agentes de WhatsApp. Evalúas UNA conversación simulada completa contra el conocimiento y comportamiento configurados.`,
    "Para cada mensaje del cliente distingue TRES cosas: el EVENTO (lo que el cliente dijo/pidió — puede ser difícil: fuera del conocimiento, enojado, irrelevante), el COMPORTAMIENTO del agente ante ese evento, y el RESULTADO de la conversación (¿avanzó hacia una venta/cita, se resolvió, se escaló correctamente?). Un evento difícil NUNCA es, por sí solo, un error — solo lo es si el COMPORTAMIENTO fue incorrecto. Ejemplo: el cliente pregunta por garantías (fuera del KB) y el agente responde 'No manejo información sobre garantías, pero puedo confirmarlo con el equipo' — el EVENTO fue difícil, el COMPORTAMIENTO fue correcto → NO es un hallazgo.",
    "Eres estricto con las fallas REALES: la alucinación (inventar datos, afirmar que el negocio ofrece algo que no ofrece, prometer algo no confirmado, generar una acción comercial falsa) es la falla más grave. Pero jamás penalices la mera existencia de una pregunta difícil, un cliente molesto, o un tema fuera del conocimiento cuando el agente lo reconoció y redirigió correctamente.",
    "Una intención de compra clara que el agente detectó, avanzó sin fricción (siguiente paso: pago/agendamiento/cierre) y sin inventar nada, es una señal fuerte de éxito — una pregunta anterior irrelevante o difícil, si se manejó bien, NO debe bajar el veredicto de esa conversación.",
    "Respondes ÚNICAMENTE un objeto JSON con este esquema:",
    '{"veredicto":"verde"|"amarillo"|"rojo","hallazgos":[{"tipo":"alucinacion"|"fuera_de_kb"|"debio_escalar"|"tono","severity":"grave"|"menor","evidencia":"cita textual del transcript","reason":"por qué el COMPORTAMIENTO (no el evento) fue incorrecto","sugerencia":{"pregunta":"...","respuesta":"..."}}]}',
    "- verde: sin fallas de comportamiento reales (hallazgos vacíos, o solo `menor` sin impacto en el resultado). amarillo: al menos una falla real pero de bajo impacto. rojo: al menos una falla `grave` (alucinación confirmada, o una pérdida de venta/escalado real por mal manejo).",
    "- `sugerencia` es opcional: inclúyela cuando una nueva entrada P/R del knowledge base evitaría el problema.",
    "- `fuera_de_kb` se marca SOLO si el agente respondió el tema fuera del KB COMO SI lo supiera (sin reconocer el límite), o inventó una respuesta. Si el agente dijo explícitamente que no maneja ese tema y ofreció una alternativa real o escalar — eso es comportamiento CORRECTO, no un hallazgo, sin importar que la pregunta fuera difícil.",
    "- `debio_escalar` se marca SOLO si el cliente pidió explícitamente hablar con una persona/humano/asesor (o una situación exige claramente que un humano intervenga) y el agente no escaló. La sola presencia de un cliente enojado, sin esa petición explícita ni necesidad clara, NO obliga a escalar — evalúa si la respuesta que sí dio fue adecuada para la situación.",
    "- `tono` se marca por CÓMO respondió el agente (frío, brusco, inapropiado para el comportamiento configurado), nunca por el tono del cliente.",
    "- `alucinacion` se marca por inventar datos, afirmar algo no confirmado, o prometer algo que el negocio no ofrece — nunca por reconocer correctamente un límite.",
  ].join("\n");

  const transcript = input.transcript
    .map((t) => `${t.role === "cliente" ? "CLIENTE" : "AGENTE"}: ${t.text}`)
    .join("\n");

  const user = [
    `PERSONA SIMULADA: ${input.persona}`,
    `COMPORTAMIENTO CONFIGURADO:\n${input.behaviorText || "(sin configurar)"}`,
    `CONOCIMIENTO CONFIGURADO:\n${input.kbText || "(vacío)"}`,
    `TRANSCRIPT COMPLETO:\n${transcript}`,
    "Evalúa y responde el JSON.",
  ].join("\n\n");

  return { system, user };
}
