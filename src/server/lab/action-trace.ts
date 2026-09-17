import { getSql } from "@/lib/db";
import { newId } from "@/lib/db/ids";

export type AgentActionTraceEntry = {
  turn: number;
  customerMessage: string;
  agentMessages: string[];
  observedActions: Array<
    "reply" | "handoff" | "update_lead" | "move_stage" | "book_slot"
  >;
  result: {
    handoffReason: string | null;
    contactNotesChanged: boolean;
    stageChanged: { from: string | null; to: string | null } | null;
    bookingCreated: boolean;
  };
};

export type AgentActionTrace = AgentActionTraceEntry[];

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
  await sql`
    INSERT INTO agent_test_action_trace (
      id, organization_id, test_case_id, trace
    ) VALUES (
      ${newId("testTrace")},
      ${input.organizationId},
      ${input.testCaseId},
      ${sql.json(input.trace)}
    )
    ON CONFLICT (organization_id, test_case_id)
    DO UPDATE SET trace = EXCLUDED.trace
  `;
}
