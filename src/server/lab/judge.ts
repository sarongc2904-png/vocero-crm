import { z } from "zod";
import { chatJson } from "@/lib/ai";
import { buildJudgePrompt } from "@/server/ai/prompts";
import type { AgentActionTrace } from "@/server/lab/action-trace";
import { canonicalDigest, freezeJson } from "@/server/lab/digest";
import {
  matchesConfiguredEscalation,
  matchesHandoffIntent,
} from "@/server/ai/handoff";

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
      tipo: z.enum([
        "alucinacion",
        "fuera_de_kb",
        "debio_escalar",
        "handoff_innecesario",
        "tono",
      ]),
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

/**
 * Versión de las REGLAS de adjudicación determinista.
 *
 * Sube cuando cambia cualquier regla que pueda alterar el veredicto final a
 * partir del mismo veredicto crudo. Un registro persistido con otra versión no
 * se considera replayable sin revisar el cambio.
 */
export const ADJUDICATION_VERSION = 2;

/**
 * Temperatura del juez. El juez no es creativo: es un evaluador con rúbrica.
 * Fijar 0 elimina la varianza de muestreo del proveedor; sin esto, "el mismo
 * caso" podía dar dos veredictos distintos con el mismo prompt.
 */
export const JUDGE_TEMPERATURE = 0;

/**
 * Registro reproducible de una evaluación: todo lo necesario para volver a
 * derivar el veredicto final SIN llamar al modelo.
 */
export type JudgeRecord = {
  /** ADJUDICATION_VERSION con la que se adjudicó. */
  version: number;
  status: "done" | "judge_failed";
  detail: string | null;
  judgeModel: string;
  temperature: number;
  /**
   * Comportamiento configurado que se usó para adjudicar (reglas de escalado).
   * Se guarda porque el perfil del agente puede cambiar después: un replay
   * fiel no puede depender de estado mutable.
   */
  behaviorText: string;
  /** Digest del Evidence Snapshot que se inyectó al prompt. */
  evidenceDigest: string;
  /** Prompt exacto enviado (el del primer intento). */
  judgePrompt: { system: string; user: string };
  /** Digest del prompt + modelo + temperatura. */
  judgeInputDigest: string;
  /** Salida cruda del modelo, antes de anclar y normalizar. */
  rawVerdict: VerdictType | null;
  /** Veredicto final tras la adjudicación determinista. */
  finalVerdict: VerdictType | null;
  verdictDigest: string | null;
};

export type JudgeOutcome =
  | { status: "done"; verdict: VerdictType; record: JudgeRecord }
  | { status: "judge_failed"; detail: string; record: JudgeRecord };

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

function actionTraceSupportsOfferedSlots(
  message: string,
  actionTrace: AgentActionTrace
): boolean {
  return actionTrace.some(
    (trace) =>
      trace.observedActions.includes("offer_slots") &&
      trace.agentMessages.includes(message)
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

/**
 * Patrones de "dato concreto": una cifra que, si no está respaldada, convierte
 * la respuesta en una afirmación verificable (y por tanto en una posible
 * alucinación). Compartidos por la protección de abstenciones y por el
 * grounding contra la evidencia congelada, para que ambas hablen del mismo
 * concepto.
 */
const CONCRETE_FIGURE_PATTERNS: RegExp[] = [
  /(?:\$|mxn|usd)\s*\d[\d.,]*/g,
  /\b\d{1,2}[:.]\d{2}\b/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
];

/** Cifras concretas presentes en un texto YA normalizado. */
function concreteFigures(normalizedText: string): string[] {
  const figures: string[] = [];
  for (const pattern of CONCRETE_FIGURE_PATTERNS) {
    for (const match of normalizedText.matchAll(pattern)) {
      const value = match[0];
      if (value) figures.push(value);
    }
  }
  return figures;
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

  // Una transferencia a humano NO equivale por sí sola a una abstención
  // segura. "No tengo ese dato, necesito verificarlo" sí lo es; "voy a
  // pasarte con un asesor" es un handoff y debe evaluarse por separado.
  //
  // Esto evita ocultar handoffs innecesarios detrás de la protección contra
  // falsos positivos de fuera_de_kb.
  const concreteUnsupportedFact = concreteFigures(value).length > 0;

  return explicitlyUnknown && !concreteUnsupportedFact;
}

/**
 * ¿El agente solo afirmó datos que están textualmente en la evidencia que se
 * le dio al juez?
 *
 * Si TODAS las cifras concretas del mensaje aparecen en el Evidence Snapshot,
 * entonces el backend puede DESMENTIR una acusación de alucinación o de
 * "respondió fuera de la KB": el dato estaba en el conocimiento disponible.
 *
 * Es deliberadamente conservador: con cero cifras concretas devuelve `false`
 * (la regla no aplica y el hallazgo del juez se respeta), y basta una cifra
 * ausente para no desmentir nada. La comparación ignora espacios para tolerar
 * "$700" frente a "$ 700", pero exige que los dígitos estén contiguos.
 */
function evidenceGroundsMessage(
  message: string,
  normalizedEvidenceText: string
): boolean {
  const figures = concreteFigures(normalizeForSafetyCheck(message));
  if (figures.length === 0) return false;

  const compactEvidence = normalizedEvidenceText.replace(/\s+/g, "");
  return figures.every((figure) =>
    compactEvidence.includes(figure.replace(/\s+/g, ""))
  );
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

function escalationRulesFromBehavior(behaviorText?: string): string | null {
  if (!behaviorText) return null;

  const line = behaviorText
    .split("\n")
    .find((value) => value.trim().toLowerCase().startsWith("escalado:"));

  return line ? line.slice(line.indexOf(":") + 1).trim() : null;
}

const SEVERITY_RANK: Record<VerdictType["hallazgos"][number]["severity"], number> = {
  grave: 0,
  menor: 1,
};

const FINDING_TYPE_RANK: Record<VerdictType["hallazgos"][number]["tipo"], number> = {
  alucinacion: 0,
  fuera_de_kb: 1,
  debio_escalar: 2,
  handoff_innecesario: 3,
  tono: 4,
};

function evidenceRefKey(
  ref: VerdictType["hallazgos"][number]["evidenceRefs"][number]
): string {
  return `${ref.source === "agent_message" ? 0 : 1}:${String(ref.index).padStart(6, "0")}`;
}

/**
 * Orden canónico de los hallazgos.
 *
 * El modelo los devuelve en el orden que quiere; para que dos corridas del
 * mismo caso produzcan el mismo veredicto persistido (mismo digest, misma UI),
 * el backend los reordena con un criterio total: gravedad, tipo, primera
 * referencia de evidencia y, como último desempate, el texto del motivo.
 */
export function orderHallazgos(
  hallazgos: VerdictType["hallazgos"]
): VerdictType["hallazgos"] {
  return [...hallazgos].sort((a, b) => {
    const severity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severity !== 0) return severity;

    const type = FINDING_TYPE_RANK[a.tipo] - FINDING_TYPE_RANK[b.tipo];
    if (type !== 0) return type;

    const aRef = a.evidenceRefs.map(evidenceRefKey).sort().join("|");
    const bRef = b.evidenceRefs.map(evidenceRefKey).sort().join("|");
    if (aRef !== bRef) return aRef < bRef ? -1 : 1;

    if (a.reason === b.reason) return 0;
    return a.reason < b.reason ? -1 : 1;
  });
}

function normalizeVerdictConsistency(input: {
  verdict: VerdictType;
  transcript: { role: "cliente" | "agente"; text: string }[];
  actionTrace: AgentActionTrace;
  behaviorText?: string;
  evidenceText?: string;
}): VerdictType {
  const hasHandoff = actionTraceHasHandoff(input.actionTrace);
  const escalationRules = escalationRulesFromBehavior(input.behaviorText);
  const normalizedEvidence = input.evidenceText
    ? normalizeForSafetyCheck(input.evidenceText)
    : null;

  const hallazgos = input.verdict.hallazgos.filter((finding) => {
    // Si el backend observó un handoff real, no puede existir un hallazgo
    // "debió escalar". El juez puede haber citado solo el farewell y omitir el
    // action_trace, así que la consistencia se valida contra TODO el trace.
    if (finding.tipo === "debio_escalar" && hasHandoff) {
      return false;
    }

    if (finding.tipo === "handoff_innecesario") {
      const citedHandoffs = finding.evidenceRefs.flatMap((ref) => {
        if (ref.source !== "action_trace") return [];

        const trace = input.actionTrace[ref.index];
        if (!trace) return [];

        const observed =
          trace.observedActions.includes("handoff") ||
          trace.result.handoffReason !== null;

        return observed ? [trace] : [];
      });

      if (citedHandoffs.length === 0) {
        return false;
      }

      const justified = citedHandoffs.some((trace) => {
        if (trace.result.handoffReason === "cliente") return true;

        if (matchesHandoffIntent(trace.customerMessage)) {
          return true;
        }

        return matchesConfiguredEscalation(
          trace.customerMessage,
          escalationRules
        );
      });

      if (justified) {
        return false;
      }
    }

    // Grounding contra la evidencia congelada: una afirmación cuyas cifras
    // están en el conocimiento que el juez recibió no es una alucinación ni una
    // respuesta fuera de la KB. Se evalúa ANTES de las reglas de texto libre
    // porque es la comprobación más fuerte (dato ↔ dato).
    if (
      normalizedEvidence !== null &&
      (finding.tipo === "alucinacion" || finding.tipo === "fuera_de_kb")
    ) {
      const citedAgentMessages = findingAgentEvidence(
        finding,
        input.transcript
      );
      if (
        citedAgentMessages.length > 0 &&
        citedAgentMessages.every((message) =>
          evidenceGroundsMessage(message, normalizedEvidence)
        )
      ) {
        return false;
      }
    }

    if (finding.tipo === "alucinacion") {
      const citedAgentMessages = findingAgentEvidence(
        finding,
        input.transcript
      );

      const backedByRealAvailability =
        citedAgentMessages.length > 0 &&
        citedAgentMessages.every((message) =>
          actionTraceSupportsOfferedSlots(message, input.actionTrace)
        );

      if (backedByRealAvailability) {
        return false;
      }

      if (hasHandoff) {
        const handoffClaim = citedAgentMessages.some((message) => {
          const value = normalizeForSafetyCheck(message);
          return (
            /\b(voy a|puedo|te puedo|prefieres que te)\b.{0,50}\b(escalar|transferir|pasar|comunicar)\b/.test(
              value
            ) ||
            /\b(asesor|persona|equipo)\b.{0,50}\b(continu|atender|contact|comunicar)\b/.test(
              value
            )
          );
        });

        if (handoffClaim) {
          return false;
        }
      }
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

  const ordered = orderHallazgos(hallazgos);
  const hasGrave = ordered.some((finding) => finding.severity === "grave");
  return {
    veredicto: hasGrave ? "rojo" : "amarillo",
    hallazgos: ordered,
  };
}

/**
 * Valida referencias contra fuentes reales y reconstruye `evidencia`.
 * Una frase del cliente jamás puede convertirse en prueba de alucinación:
 * para ese tipo exigimos al menos una referencia `agent_message` válida.
 *
 * Es PURA: mismo veredicto crudo + mismo contexto ⇒ mismo veredicto final.
 * Muta el objeto `verdict` recibido (sobrescribe `evidencia`), así que quien
 * necesite conservar la salida cruda del modelo debe pasar una copia.
 */
export function validateAndAnchorVerdict(input: {
  verdict: VerdictType;
  transcript: { role: "cliente" | "agente"; text: string }[];
  actionTrace: AgentActionTrace;
  behaviorText?: string;
  evidenceText?: string;
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
      behaviorText: input.behaviorText,
      evidenceText: input.evidenceText,
    }),
  };
}

function findingIdentity(finding: VerdictType["hallazgos"][number]): string {
  return canonicalDigest({
    tipo: finding.tipo,
    severity: finding.severity,
    reason: finding.reason,
    evidenceRefs: finding.evidenceRefs,
  });
}

/**
 * Adjudicación pura y reproducible offline. El modelo sólo propone hallazgos;
 * esta función decide cuáles sobreviven a los hechos observados.
 */
export function adjudicate(input: {
  llmVerdict: VerdictType;
  transcript: { role: "cliente" | "agente"; text: string }[];
  actionTrace: AgentActionTrace;
  behaviorText?: string;
  evidenceText?: string;
}):
  | {
      ok: true;
      version: number;
      verdict: VerdictType;
      acceptedFindings: VerdictType["hallazgos"];
      rejectedFindings: Array<{
        finding: VerdictType["hallazgos"][number];
        reason: "rejected_by_deterministic_grounding";
      }>;
      inputDigest: string;
    }
  | { ok: false; detail: string } {
  const frozenInput = freezeJson(input);
  const result = validateAndAnchorVerdict({
    verdict: frozenInput.llmVerdict,
    transcript: frozenInput.transcript,
    actionTrace: frozenInput.actionTrace,
    behaviorText: frozenInput.behaviorText,
    evidenceText: frozenInput.evidenceText,
  });
  if (!result.ok) return result;

  const acceptedIds = new Set(result.verdict.hallazgos.map(findingIdentity));
  return {
    ok: true,
    version: ADJUDICATION_VERSION,
    verdict: result.verdict,
    acceptedFindings: result.verdict.hallazgos,
    rejectedFindings: input.llmVerdict.hallazgos
      .filter((finding) => !acceptedIds.has(findingIdentity(finding)))
      .map((finding) => ({
        finding: freezeJson(finding),
        reason: "rejected_by_deterministic_grounding" as const,
      })),
    inputDigest: canonicalDigest(frozenInput),
  };
}

function judgeInputDigestOf(input: {
  model: string;
  temperature: number;
  system: string;
  user: string;
}): string {
  return canonicalDigest(input);
}

/**
 * Verifica la coherencia interna de un registro: los digests deben corresponder
 * al prompt y al veredicto que el registro dice contener. Detecta ediciones
 * posteriores del JSON persistido.
 */
export function verifyJudgeRecord(
  record: JudgeRecord
): { ok: true } | { ok: false; detail: string } {
  const inputDigest = judgeInputDigestOf({
    model: record.judgeModel,
    temperature: record.temperature,
    system: record.judgePrompt.system,
    user: record.judgePrompt.user,
  });
  if (inputDigest !== record.judgeInputDigest) {
    return {
      ok: false,
      detail: `judge_input_digest_mismatch: esperado=${record.judgeInputDigest} real=${inputDigest}`,
    };
  }

  if (record.finalVerdict !== null && record.verdictDigest !== null) {
    const verdictDigest = canonicalDigest(record.finalVerdict);
    if (verdictDigest !== record.verdictDigest) {
      return {
        ok: false,
        detail: `verdict_digest_mismatch: esperado=${record.verdictDigest} real=${verdictDigest}`,
      };
    }
  }

  return { ok: true };
}

/**
 * Replay determinista: vuelve a derivar el veredicto final a partir del
 * veredicto CRUDO persistido y del contexto original, sin llamar al modelo.
 *
 * `matches === true` significa que la adjudicación actual reproduce exactamente
 * el veredicto que se guardó.
 */
export function replayJudgeVerdict(input: {
  record: JudgeRecord;
  transcript: { role: "cliente" | "agente"; text: string }[];
  actionTrace: AgentActionTrace;
  behaviorText?: string;
  evidenceText?: string;
}):
  | { ok: true; verdict: VerdictType; verdictDigest: string; matches: boolean }
  | { ok: false; detail: string } {
  const integrity = verifyJudgeRecord(input.record);
  if (!integrity.ok) return { ok: false, detail: integrity.detail };

  if (input.record.status !== "done" || input.record.rawVerdict === null) {
    return {
      ok: false,
      detail: `record_not_replayable: la corrida no produjo veredicto (status=${input.record.status}${input.record.detail ? `, ${input.record.detail}` : ""})`,
    };
  }

  const anchored = adjudicate({
    llmVerdict: freezeJson(input.record.rawVerdict),
    transcript: input.transcript,
    actionTrace: input.actionTrace,
    // El comportamiento configurado se toma del propio registro cuando el
    // llamador no lo aporta: el perfil vivo puede haber cambiado.
    behaviorText: input.behaviorText ?? input.record.behaviorText,
    evidenceText: input.evidenceText,
  });
  if (!anchored.ok) {
    return { ok: false, detail: anchored.detail };
  }

  const verdictDigest = canonicalDigest(anchored.verdict);
  return {
    ok: true,
    verdict: anchored.verdict,
    verdictDigest,
    matches: verdictDigest === input.record.verdictDigest,
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
  /** Digest del Evidence Snapshot congelado que respalda `kbText`. */
  evidenceDigest?: string;
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

  const groundedUser = `${user}\n\nFUENTES DE EVIDENCIA AUTORIZADAS\n${indexedAgentMessages || "(sin mensajes del agente)"}\n${indexedTrace || "(sin acciones observadas)"}\n\nREGLAS DE EVIDENCIA\n- Cada hallazgo DEBE incluir evidenceRefs con uno o más índices válidos de las fuentes anteriores.\n- Usa source=agent_message para texto producido por el agente y source=action_trace para efectos/acciones observados.\n- NUNCA uses una frase del cliente como evidencia de una alucinación del agente.\n- Para tipo=alucinacion es obligatorio incluir al menos un agent_message.\n- El campo evidencia puede ser breve: el backend lo reconstruirá desde evidenceRefs.`;

  const result = await chatJson(
    Verdict,
    [
      { role: "system", content: system },
      { role: "user", content: groundedUser },
    ],
    { judge: true, temperature: JUDGE_TEMPERATURE }
  );

  const judgeModel = result.ok ? (result.model ?? "(desconocido)") : "(sin modelo)";
  const judgePrompt = { system, user: groundedUser };
  const baseRecord = {
    version: ADJUDICATION_VERSION,
    judgeModel,
    temperature: JUDGE_TEMPERATURE,
    behaviorText: input.behaviorText,
    evidenceDigest: input.evidenceDigest ?? "",
    judgePrompt,
    judgeInputDigest: judgeInputDigestOf({
      model: judgeModel,
      temperature: JUDGE_TEMPERATURE,
      system,
      user: groundedUser,
    }),
  } satisfies Omit<
    JudgeRecord,
    "status" | "detail" | "rawVerdict" | "finalVerdict" | "verdictDigest"
  >;

  if (!result.ok) {
    console.error(
      `[lab] juez falló para ${input.personaKey}: ${result.error} — ${result.detail}`
    );
    return {
      status: "judge_failed",
      detail: result.detail,
      record: {
        ...baseRecord,
        status: "judge_failed",
        detail: result.detail,
        rawVerdict: null,
        finalVerdict: null,
        verdictDigest: null,
      },
    };
  }

  const rawVerdict = freezeJson(result.data);
  const anchored = adjudicate({
    llmVerdict: freezeJson(rawVerdict),
    transcript: input.transcript,
    actionTrace: input.actionTrace,
    behaviorText: input.behaviorText,
    evidenceText: input.kbText,
  });
  if (!anchored.ok) {
    console.error(`[lab] evidencia inválida para ${input.personaKey}: ${anchored.detail}`);
    return {
      status: "judge_failed",
      detail: anchored.detail,
      record: {
        ...baseRecord,
        status: "judge_failed",
        detail: anchored.detail,
        rawVerdict,
        finalVerdict: null,
        verdictDigest: null,
      },
    };
  }

  return {
    status: "done",
    verdict: anchored.verdict,
    record: {
      ...baseRecord,
      status: "done",
      detail: null,
      rawVerdict,
      finalVerdict: anchored.verdict,
      verdictDigest: canonicalDigest(anchored.verdict),
    },
  };
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
