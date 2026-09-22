import { z } from "zod";
import { chatJson } from "@/lib/ai";
import { buildJudgePrompt } from "@/server/ai/prompts";
import type { AgentActionTrace } from "@/server/lab/action-trace";

export const EvidenceRef = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("agent_message"),
    index: z.number().int().min(0),
  }),
  z.object({
    source: z.literal("action_trace"),
    index: z.number().int().min(0),
  }),
]);

/**
 * Veredicto estructurado del juez (FR-032, contrato ai.md).
 *
 * Wave 1: cada hallazgo debe apuntar a una salida del AGENTE o a un elemento
 * del action trace. `evidencia` se conserva por compatibilidad con la UI, pero
 * ya no se confía en el texto libre del juez: el backend lo reconstruye desde
 * `evidenceRefs` después de validar índices y procedencia.
 */
export const Verdict = z.object({
  veredicto: z.enum(["verde", "amarillo", "rojo"]),
  hallazgos: z.array(
    z.object({
      tipo: z.enum(["alucinacion", "fuera_de_kb", "debio_escalar", "tono"]),
      severity: z.enum(["grave", "menor"]),
      evidencia: z.string(),
      evidenceRefs: z.array(EvidenceRef).min(1),
      reason: z.string(),
      sugerencia: z
        .object({ pregunta: z.string(), respuesta: z.string() })
        .optional(),
    })
  ),
});

export type VerdictType = z.infer<typeof Verdict>;
export type EvidenceRefType = z.infer<typeof EvidenceRef>;

export type JudgeOutcome =
  | { status: "done"; verdict: VerdictType }
  | { status: "judge_failed"; detail: string };

function agentMessages(
  transcript: { role: "cliente" | "agente"; text: string }[]
): string[] {
  return transcript.filter((m) => m.role === "agente").map((m) => m.text);
}

function renderTraceEvidence(trace: AgentActionTrace[number]): string {
  return JSON.stringify({
    turn: trace.turn,
    observedActions: trace.observedActions,
    result: trace.result,
  });
}

function actionTraceHasHandoff(actionTrace: AgentActionTrace): boolean {
  return actionTrace.some(
    (trace) =>
      trace.observedActions.includes("handoff") ||
      trace.result.handoffReason !== null
  );
}

function normalizeForSafetyCheck(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isSafeKnowledgeAbstention(text: string): boolean {
  const value = normalizeForSafetyCheck(text);

  const explicitlyUnknown =
    /\b(no tengo|no cuento con|desconozco|necesito|debo|tengo que)\b.{0,80}\b(informacion|dato|precio|precios|costo|costos|detalle|detalles|confirmar|verificar|revisar)\b/.test(
      value
    ) ||
    /\b(confirmar|verificar|revisar)(?:lo|la|los|las)?\b.{0,60}\b(equipo|asesor|persona)\b/.test(
      value
    );

  const explicitHandoff =
    /\b(voy a|puedo|te puedo|prefieres que te)\b.{0,50}\b(escalar|transferir|pasar|comunicar)\b/.test(
      value
    ) ||
    /\b(asesor|persona|equipo)\b.{0,50}\b(ayud|continu|confirm)/.test(value);

  // Una abstención segura no puede colar a la vez un precio/fecha/hora
  // concreta, que sí sería una afirmación factual evaluable.
  const concreteUnsupportedFact =
    /(?:\$|mxn|usd)\s*\d/i.test(text) ||
    /\b\d{1,2}[:.]\d{2}\b/.test(text) ||
    /\b\d{4}-\d{2}-\d{2}\b/.test(text);

  return (explicitlyUnknown || explicitHandoff) && !concreteUnsupportedFact;
}

function findingAgentEvidence(
  finding: VerdictType["hallazgos"][number],
  transcript: { role: "cliente" | "agente"; text: string }[]
): string[] {
  const messages = agentMessages(transcript);
  return finding.evidenceRefs.flatMap((ref) =>
    ref.source === "agent_message" && messages[ref.index] !== undefined
      ? [messages[ref.index]!]
      : []
  );
}

function normalizeVerdictConsistency(input: {
  verdict: VerdictType;
  transcript: { role: "cliente" | "agente"; text: string }[];
  actionTrace: AgentActionTrace;
}): VerdictType {
  const hasHandoff = actionTraceHasHandoff(input.actionTrace);

  const hallazgos = input.verdict.hallazgos.filter((finding) => {
    // Si el backend observó un handoff real, no puede existir un hallazgo
    // "debió escalar". El juez puede haber citado solo el farewell y omitir el
    // action_trace, así que la consistencia se valida contra TODO el trace.
    if (finding.tipo === "debio_escalar" && hasHandoff) {
      return false;
    }

    if (finding.tipo === "fuera_de_kb") {
      const citedAgentMessages = findingAgentEvidence(finding, input.transcript);
      if (
        citedAgentMessages.length > 0 &&
        citedAgentMessages.every(isSafeKnowledgeAbstention)
      ) {
        return false;
      }
    }

    return true;
  });

  if (hallazgos.length === 0) {
    return { veredicto: "verde", hallazgos: [] };
  }

  const hasGrave = hallazgos.some((finding) => finding.severity === "grave");
  return {
    veredicto: hasGrave ? "rojo" : "amarillo",
    hallazgos,
  };
}

/**
 * Valida referencias contra fuentes reales y reconstruye `evidencia`.
 * Una frase del cliente jamás puede convertirse en prueba de alucinación:
 * para ese tipo exigimos al menos una referencia `agent_message` válida.
 */
export function validateAndAnchorVerdict(input: {
  verdict: VerdictType;
  transcript: { role: "cliente" | "agente"; text: string }[];
  actionTrace: AgentActionTrace;
}): { ok: true; verdict: VerdictType } | { ok: false; detail: string } {
  const messages = agentMessages(input.transcript);

  for (let findingIndex = 0; findingIndex < input.verdict.hallazgos.length; findingIndex++) {
    const finding = input.verdict.hallazgos[findingIndex]!;
    const anchored: string[] = [];
    let hasAgentMessage = false;

    for (const ref of finding.evidenceRefs) {
      if (ref.source === "agent_message") {
        const text = messages[ref.index];
        if (text === undefined) {
          return {
            ok: false,
            detail: `invalid_evidence_ref: hallazgo=${findingIndex} agent_message=${ref.index}`,
          };
        }
        hasAgentMessage = true;
        anchored.push(text);
        continue;
      }

      const trace = input.actionTrace[ref.index];
      if (!trace) {
        return {
          ok: false,
          detail: `invalid_evidence_ref: hallazgo=${findingIndex} action_trace=${ref.index}`,
        };
      }
      anchored.push(renderTraceEvidence(trace));
    }

    if (finding.tipo === "alucinacion" && !hasAgentMessage) {
      return {
        ok: false,
        detail: `invalid_evidence_ref: hallazgo=${findingIndex} alucinacion_requires_agent_message`,
      };
    }

    finding.evidencia = anchored.join("\n---\n");
  }

  return {
    ok: true,
    verdict: normalizeVerdictConsistency({
      verdict: input.verdict,
      transcript: input.transcript,
      actionTrace: input.actionTrace,
    }),
  };
}

/** UNA llamada del juez por conversación; la corrida continúa si falla. */
export async function judgeCase(input: {
  personaKey: string;
  transcript: { role: "cliente" | "agente"; text: string }[];
  kbText: string;
  behaviorText: string;
  actionTrace: AgentActionTrace;
  agendaEnabled?: boolean;
}): Promise<JudgeOutcome> {
  const { system, user } = buildJudgePrompt({
    persona: input.personaKey,
    transcript: input.transcript,
    kbText: input.kbText,
    behaviorText: input.behaviorText,
    agendaEnabled: input.agendaEnabled,
  });

  const indexedAgentMessages = agentMessages(input.transcript)
    .map((text, index) => `[agent_message:${index}] ${text}`)
    .join("\n");
  const indexedTrace = input.actionTrace
    .map((entry, index) => `[action_trace:${index}] ${renderTraceEvidence(entry)}`)
    .join("\n");

  const groundedUser = `${user}\n\nFUENTES DE EVIDENCIA AUTORIZADAS\n${
    indexedAgentMessages || "(sin mensajes del agente)"
  }\n${indexedTrace || "(sin acciones observadas)"}\n\nREGLAS DE EVIDENCIA\n- Cada hallazgo DEBE incluir evidenceRefs con uno o más índices válidos de las fuentes anteriores.\n- Usa source=agent_message para texto producido por el agente y source=action_trace para efectos/acciones observados.\n- NUNCA uses una frase del cliente como evidencia de una alucinación del agente.\n- Para tipo=alucinacion es obligatorio incluir al menos un agent_message.\n- El campo evidencia puede ser breve: el backend lo reconstruirá desde evidenceRefs.`;

  const result = await chatJson(
    Verdict,
    [
      { role: "system", content: system },
      { role: "user", content: groundedUser },
    ],
    { judge: true }
  );
  if (!result.ok) {
    console.error(
      `[lab] juez falló para ${input.personaKey}: ${result.error} — ${result.detail}`
    );
    return { status: "judge_failed", detail: result.detail };
  }

  const anchored = validateAndAnchorVerdict({
    verdict: result.data,
    transcript: input.transcript,
    actionTrace: input.actionTrace,
  });
  if (!anchored.ok) {
    console.error(`[lab] evidencia inválida para ${input.personaKey}: ${anchored.detail}`);
    return { status: "judge_failed", detail: anchored.detail };
  }

  return { status: "done", verdict: anchored.verdict };
}

/**
 * Score 0-100: % ponderado de conversaciones verdes (FR-033).
 * verde = 1 · amarillo = 0.5 · rojo = 0. judge_failed fuera del denominador.
 * F011 queda explícitamente fuera de Wave 1.
 */
export function computeScore(
  cases: { status: string; veredicto: string | null }[]
): number | null {
  const judged = cases.filter(
    (c) => c.status === "done" && c.veredicto !== null
  );
  if (judged.length === 0) return null;
  const points = judged.reduce((acc, c) => {
    if (c.veredicto === "verde") return acc + 1;
    if (c.veredicto === "amarillo") return acc + 0.5;
    return acc;
  }, 0);
  return Math.round((100 * points) / judged.length);
}
