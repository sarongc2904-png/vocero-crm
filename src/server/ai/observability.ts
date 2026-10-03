import { AsyncLocalStorage } from "node:async_hooks";
import { getSql } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { canonicalDigest, freezeJson } from "@/server/lab/digest";

export const OBSERVABLE_AGENT_ACTIONS = [
  "reply",
  "handoff",
  "update_lead",
  "move_stage",
  "offer_slots",
  "book_slot",
  "reschedule_slot",
  "cancel_booking",
  "set_pending_book",
  "set_pending_reschedule",
  "set_pending_cancel",
] as const;

export type ObservableAgentAction = (typeof OBSERVABLE_AGENT_ACTIONS)[number];
export type AgentEvidenceSource =
  | "kb_entry"
  | "document_chunk"
  | "agenda"
  | "agent_profile"
  | "conversation_context";

type RunContext = { runId: string; organizationId: string; conversationId: string };
const runStorage = new AsyncLocalStorage<RunContext>();

const SECRET_KEY = /(authorization|password|passphrase|secret|token|api[_-]?key|cipher|client[_-]?secret|private[_-]?key)/i;
const BEARER = /bearer\s+[a-z0-9._~+/=-]+/gi;

export function sanitizeObservabilityValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[MAX_DEPTH]";
  if (typeof value === "string") {
    return value.replace(BEARER, "Bearer [REDACTED]").slice(0, 8_000);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((entry) => sanitizeObservabilityValue(entry, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const clean: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      clean[key] = SECRET_KEY.test(key)
        ? "[REDACTED]"
        : sanitizeObservabilityValue(entry, depth + 1);
    }
    return clean;
  }
  return value;
}

export function sanitizeObservabilityError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return String(sanitizeObservabilityValue(text)).slice(0, 2_000);
}

export async function createAgentRun(input: {
  organizationId: string;
  conversationId: string;
  inboundMessageId?: string | null;
  provider?: string | null;
  model?: string | null;
}): Promise<RunContext> {
  const sql = getSql();
  const runId = newId("agentRun");
  const traceId = crypto.randomUUID();
  await sql`
    INSERT INTO agent_run (
      id, organization_id, conversation_id, inbound_message_id,
      provider, model, status, trace_id
    ) VALUES (
      ${runId}, ${input.organizationId}, ${input.conversationId},
      ${input.inboundMessageId ?? null}, ${input.provider ?? null},
      ${input.model ?? null}, 'running', ${traceId}
    )
  `;
  return { runId, organizationId: input.organizationId, conversationId: input.conversationId };
}

export async function withAgentRun<T>(context: RunContext, fn: () => Promise<T>): Promise<T> {
  return runStorage.run(context, fn);
}

export async function finishAgentRun(
  context: RunContext,
  outcome: { status: "completed" } | { status: "failed"; error: unknown }
): Promise<void> {
  const sql = getSql();
  const error = outcome.status === "failed" ? sanitizeObservabilityError(outcome.error) : null;
  await sql`
    UPDATE agent_run
    SET status = ${outcome.status}, completed_at = now(), error = ${error}
    WHERE organization_id = ${context.organizationId} AND id = ${context.runId}
  `;
}

export async function recordAgentAction(input: {
  action: ObservableAgentAction;
  success?: boolean;
  status?: string;
  entityType?: string | null;
  entityId?: string | null;
  outboundMessageId?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const context = runStorage.getStore();
  if (!context) return;
  const sql = getSql();
  const payload = freezeJson(
    sanitizeObservabilityValue(input.payload ?? {}) as Record<string, unknown>
  );
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO agent_action_event (
        id, organization_id, run_id, action, success, status,
        entity_type, entity_id, outbound_message_id, payload
      ) VALUES (
        ${newId("agentActionEvent")}, ${context.organizationId}, ${context.runId},
        ${input.action}, ${input.success ?? true}, ${input.status ?? "completed"},
        ${input.entityType ?? null}, ${input.entityId ?? null},
        ${input.outboundMessageId ?? null}, ${JSON.stringify(payload)}::jsonb
      )
    `;
    await transaction`
      UPDATE agent_run
      SET action_count = action_count + 1,
          outbound_message_id = COALESCE(${input.outboundMessageId ?? null}, outbound_message_id)
      WHERE organization_id = ${context.organizationId} AND id = ${context.runId}
    `;
  });
}

export async function recordAgentEvidence(
  items: Array<{
    sourceType: AgentEvidenceSource;
    sourceId?: string | null;
    snapshot: Record<string, unknown>;
    score?: number | null;
  }>
): Promise<void> {
  const context = runStorage.getStore();
  if (!context || items.length === 0) return;
  const sql = getSql();
  const sanitized = items.map((item, ordinal) => {
    const snapshot = freezeJson(
      sanitizeObservabilityValue(item.snapshot) as Record<string, unknown>
    );
    return { ...item, ordinal, snapshot, contentHash: canonicalDigest(snapshot) };
  });
  await sql.begin(async (transaction) => {
    for (const item of sanitized) {
      await transaction`
        INSERT INTO agent_evidence (
          id, organization_id, run_id, source_type, source_id,
          snapshot, content_hash, score, ordinal
        ) VALUES (
          ${newId("agentEvidence")}, ${context.organizationId}, ${context.runId},
          ${item.sourceType}, ${item.sourceId ?? null},
          ${JSON.stringify(item.snapshot)}::jsonb, ${item.contentHash},
          ${item.score ?? null}, ${item.ordinal}
        )
      `;
    }
    await transaction`
      UPDATE agent_run SET evidence_count = evidence_count + ${sanitized.length}
      WHERE organization_id = ${context.organizationId} AND id = ${context.runId}
    `;
  });
}
