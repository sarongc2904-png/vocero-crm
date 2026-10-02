import { getSql } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { canonicalDigest } from "@/server/lab/digest";

/**
 * Action Trace del Laboratorio.
 *
 * v1 (Wave 1) describía el turno de forma derivada y parcial: acciones
 * observadas como lista de booleanos y `agentMessages` como texto suelto. Eso
 * bastaba para anclar evidencia por posición, pero no permitía auditar QUÉ
 * mensaje ni QUÉ recurso produjo cada efecto.
 *
 * v2 añade, SIN romper v1 (las filas ya persistidas siguen siendo válidas):
 *   - identificadores estables (`customerMessageId`, `agentMessageIds`) para
 *     anclar evidencia a filas inmutables y no a posiciones;
 *   - los recursos concretos que explican cada acción (`offeredSlotIds`,
 *     `bookingIds`), así el juez puede comprobar "hubo disponibilidad real"
 *     sin depender del texto del mensaje;
 *   - el digest de la evidencia congelada de ese turno (`evidenceDigest`), que
 *     enlaza la acción con el Evidence Snapshot que la hizo posible;
 *   - orden canónico de `observedActions` y un digest del trace completo.
 */

export const ACTION_TRACE_VERSION = 2;

/** Orden canónico de las acciones observadas (v1 las emitía en este orden). */
export const AGENT_ACTIONS = [
  "reply",
  "handoff",
  "update_lead",
  "move_stage",
  "offer_slots",
  "book_slot",
] as const;

export type AgentActionName = (typeof AGENT_ACTIONS)[number];

export type AgentActionTraceEntry = {
  turn: number;
  customerMessage: string;
  agentMessages: string[];
  observedActions: AgentActionName[];
  result: {
    handoffReason: string | null;
    contactNotesChanged: boolean;
    stageChanged: { from: string | null; to: string | null } | null;
    bookingCreated: boolean;
  };
  /** v2 — id de la fila `message` entrante del turno. */
  customerMessageId?: string | null;
  /** v2 — ids de las filas `message` salientes producidas en el turno. */
  agentMessageIds?: string[];
  /** v2 — ids de `offered_slot` creados en el turno. */
  offeredSlotIds?: string[];
  /** v2 — ids de `booking` creados en el turno. */
  bookingIds?: string[];
  /** v2 — digest del Evidence Snapshot de este turno. */
  evidenceDigest?: string | null;
};

export type AgentActionTrace = AgentActionTraceEntry[];

/**
 * Normaliza un trace a la forma v2: rellena los campos que v1 no conocía y
 * fija el orden canónico de `observedActions`.
 *
 * Es una función pura: el mismo trace produce siempre el mismo resultado, así
 * que el digest es estable entre corridas y entre versiones del código.
 */
export function normalizeActionTrace(
  trace: AgentActionTrace
): AgentActionTraceEntry[] {
  return [...trace]
    .sort((a, b) => a.turn - b.turn)
    .map((entry) => ({
      ...entry,
      observedActions: canonicalActions(entry.observedActions),
      customerMessageId: entry.customerMessageId ?? null,
      agentMessageIds: [...(entry.agentMessageIds ?? [])],
      offeredSlotIds: [...(entry.offeredSlotIds ?? [])],
      bookingIds: [...(entry.bookingIds ?? [])],
      evidenceDigest: entry.evidenceDigest ?? null,
    }));
}

/** Orden canónico y sin duplicados de una lista de acciones observadas. */
export function canonicalActions(actions: AgentActionName[]): AgentActionName[] {
  const present = new Set(actions);
  return AGENT_ACTIONS.filter((action) => present.has(action));
}

/** Digest del trace normalizado: cualquier cambio de contenido lo invalida. */
export function actionTraceDigest(trace: AgentActionTrace): string {
  return canonicalDigest(normalizeActionTrace(trace));
}

/**
 * Lab-only persistence. The composite tenant/test-case key prevents a caller
 * from overwriting another organization's trace even if a test-case id leaks.
 */
export async function persistActionTrace(input: {
  organizationId: string;
  testCaseId: string;
  trace: AgentActionTrace;
}): Promise<void> {
  const sql = getSql();
  const normalized = normalizeActionTrace(input.trace);
  const traceJson = JSON.stringify(normalized);
  await sql`
    INSERT INTO agent_test_action_trace (
      id, organization_id, test_case_id, trace, version, digest
    ) VALUES (
      ${newId("testTrace")},
      ${input.organizationId},
      ${input.testCaseId},
      ${traceJson}::jsonb,
      ${ACTION_TRACE_VERSION},
      ${canonicalDigest(normalized)}
    )
    ON CONFLICT (organization_id, test_case_id)
    DO UPDATE SET
      trace = EXCLUDED.trace,
      version = EXCLUDED.version,
      digest = EXCLUDED.digest
  `;
}

export type PersistedActionTrace = {
  version: number;
  digest: string | null;
  trace: AgentActionTrace;
};

/**
 * Lectura del trace persistido. v1 era write-only; el replay del juez necesita
 * volver a leer exactamente lo que se observó.
 */
export async function loadActionTrace(input: {
  organizationId: string;
  testCaseId: string;
}): Promise<PersistedActionTrace | null> {
  const sql = getSql();
  const rows = (await sql`
    SELECT trace, version, digest
    FROM agent_test_action_trace
    WHERE organization_id = ${input.organizationId}
      AND test_case_id = ${input.testCaseId}
    LIMIT 1
  `) as unknown as Array<{
    trace: unknown;
    version: number | null;
    digest: string | null;
  }>;

  const row = rows[0];
  if (!row) return null;

  return {
    version: row.version ?? 1,
    digest: row.digest ?? null,
    trace: Array.isArray(row.trace) ? (row.trace as AgentActionTrace) : [],
  };
}
