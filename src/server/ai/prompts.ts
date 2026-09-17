import type { schema } from "@/lib/db";

type AgentProfile = typeof schema.agentProfile.$inferSelect;
type KbEntry = typeof schema.kbEntry.$inferSelect;

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

export function buildAgentSystemPrompt(input: {
  profile: AgentProfile;
  kb: KbEntry[];
  stages: { name: string }[];
  agenda?: boolean;
  today?: { iso: string; label: string };
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
        '- {"action":"offer_slots","reply":"..."} — pedir al SISTEMA que consulte y muestre disponibilidad real. Nunca calcules ni envíes tú la fecha: el backend resuelve el día pedido desde el mensaje del cliente.',
        '- {"action":"book_slot","startUtc":"<uno de los horarios que el sistema ofreció, en ISO UTC>","reply":"..."} — reservar exactamente un horario ya ofrecido por el sistema.',
      ]
    : [];
  const agendaRules = input.agenda
    ? [
        input.today
          ? `- Hoy es ${input.today.label} (fecha ISO ${input.today.iso}, según la zona del negocio). Esto es contexto; la fecha final de agenda la decide el backend.`
          : null,
        input.businessFact
          ? `- HECHO DE HORARIO DEL BACKEND: targetDate=${input.businessFact.targetDate} (${input.businessFact.dayOfWeekLabel}, zona ${input.businessFact.timezone}); negocio ${input.businessFact.businessOpen ? `ABIERTO, horario ${input.businessFact.businessHours}` : "CERRADO"}. Es verdad factual y no puede contradecirse.`
          : "- Si preguntan por apertura, cierre, horario o disponibilidad y no hay un HECHO DE HORARIO explícito, NO respondas de memoria: usa offer_slots o indica que vas a consultar disponibilidad.",
        "- NUNCA inventes fechas, días de la semana, horas, cupos, disponibilidad ni horarios comerciales.",
        "- NUNCA conviertas por tu cuenta expresiones como 'mañana', 'el domingo' o '20/09' a una fecha; el backend lo hace de forma determinista.",
        "- NUNCA escribas una lista de horarios en texto libre. Para disponibilidad usa offer_slots; el sistema insertará únicamente horarios reales.",
        "- Si el usuario pregunta 'qué horarios tienes', 'qué hay disponible', 'la próxima cita' o un rango de días, usa offer_slots; el backend decide si corresponde fecha única, rango, disponibilidad general o siguiente hueco.",
        "- book_slot solo puede usar un startUtc previamente ofrecido en ESTA conversación. Si el cliente pide otro horario, usa offer_slots otra vez.",
        "- Al confirmar una cita, no repitas ni inventes fecha/hora en reply; el sistema genera la confirmación factual.",
        "- Si el cliente quiere CANCELAR una cita → handoff.",
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
      '- {"action":"handoff","reason":"...","farewell":"..."} — escalar a un humano (farewell opcional).',
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

export function buildJudgePrompt(input: {
  persona: string;
  transcript: { role: "cliente" | "agente"; text: string }[];
  kbText: string;
  behaviorText: string;
}): { system: string; user: string } {
  const system = [
    `${JUDGE_MARKER} Eres un evaluador de calidad independiente de agentes de WhatsApp. Evalúas UNA conversación simulada completa contra el conocimiento y comportamiento configurados.`,
    "Para cada mensaje del cliente distingue TRES cosas: el EVENTO, el COMPORTAMIENTO del agente y el RESULTADO. Un evento difícil NUNCA es, por sí solo, un error; solo lo es si el comportamiento fue incorrecto.",
    "Eres estricto con fallas reales: inventar datos, horarios, disponibilidad, fechas, resultados, servicios o promesas no confirmadas es una alucinación grave.",
    "Una intención de compra clara que el agente detectó, avanzó sin fricción y sin inventar nada es una señal fuerte de éxito.",
    "Respondes ÚNICAMENTE un objeto JSON con este esquema:",
    '{"veredicto":"verde"|"amarillo"|"rojo","hallazgos":[{"tipo":"alucinacion"|"fuera_de_kb"|"debio_escalar"|"tono","severity":"grave"|"menor","evidencia":"cita textual del transcript","reason":"por qué el COMPORTAMIENTO fue incorrecto","sugerencia":{"pregunta":"...","respuesta":"..."}}]}',
    "- verde: sin fallas reales. amarillo: falla real de bajo impacto. rojo: al menos una falla grave.",
    "- `sugerencia` es opcional.",
    "- `fuera_de_kb` solo si el agente responde fuera del KB como si supiera la respuesta o inventa.",
    "- `debio_escalar` solo si pidió humano o había necesidad clara y no escaló.",
    "- `tono` evalúa cómo respondió el agente, no el tono del cliente.",
    "- `alucinacion` incluye inventar datos, fechas, horas o disponibilidad no sustentada.",
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
