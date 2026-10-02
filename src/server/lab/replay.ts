import { getSql } from "@/lib/db";
import {
  loadActionTrace,
  type AgentActionTrace,
} from "@/server/lab/action-trace";
import {
  loadEvidenceSnapshot,
  verifyEvidenceSnapshot,
  type EvidenceSnapshot,
} from "@/server/lab/evidence-snapshot";
import {
  replayJudgeVerdict,
  verifyJudgeRecord,
  type JudgeRecord,
  type VerdictType,
} from "@/server/lab/judge";

/**
 * Replay offline del juez.
 *
 * Toma de la base de datos TODO lo que determinó el veredicto —transcript,
 * action trace, evidencia congelada y registro del juez— y vuelve a derivar el
 * veredicto final con la adjudicación determinista, sin llamar al modelo. Sirve
 * para auditar una corrida vieja y para detectar que un cambio de reglas alteró
 * un veredicto histórico.
 *
 * Nada aquí depende de estado mutable (perfil del agente, documentos, KB): si
 * dependiera, el replay dejaría de ser una verificación.
 */

export type LabReplayInput = {
  organizationId: string;
  testCaseId: string;
  persona: string;
  transcript: { role: "cliente" | "agente"; text: string }[];
  actionTrace: AgentActionTrace;
  evidence: EvidenceSnapshot;
  record: JudgeRecord;
};

function parseTranscript(value: unknown): LabReplayInput["transcript"] | null {
  if (!Array.isArray(value)) return null;
  const parsed: LabReplayInput["transcript"] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") return null;
    const row = entry as { role?: unknown; text?: unknown };
    if (
      (row.role !== "cliente" && row.role !== "agente") ||
      typeof row.text !== "string"
    ) {
      return null;
    }
    parsed.push({ role: row.role, text: row.text });
  }
  return parsed;
}

/** Ensambla la entrada del replay desde Postgres, o `null` si falta algo. */
export async function loadLabReplayInput(input: {
  organizationId: string;
  testCaseId: string;
}): Promise<LabReplayInput | null> {
  const sql = getSql();
  const rows = (await sql`
    SELECT persona, transcript
    FROM agent_test_case
    WHERE organization_id = ${input.organizationId}
      AND id = ${input.testCaseId}
    LIMIT 1
  `) as unknown as Array<{ persona: string | null; transcript: unknown }>;

  const row = rows[0];
  if (!row) return null;

  const transcript = parseTranscript(row.transcript);
  if (!transcript) return null;

  const [trace, persisted] = await Promise.all([
    loadActionTrace({
      organizationId: input.organizationId,
      testCaseId: input.testCaseId,
    }),
    loadEvidenceSnapshot({
      organizationId: input.organizationId,
      testCaseId: input.testCaseId,
    }),
  ]);
  if (!trace || !persisted || !persisted.judgeRecord) return null;

  return {
    organizationId: input.organizationId,
    testCaseId: input.testCaseId,
    persona: row.persona ?? "",
    transcript,
    actionTrace: trace.trace,
    evidence: persisted.snapshot,
    record: persisted.judgeRecord,
  };
}

export type LabReplayResult =
  | {
      ok: true;
      verdict: VerdictType;
      /** La adjudicación actual reproduce el veredicto persistido. */
      matches: boolean;
      verdictDigest: string;
      storedVerdictDigest: string | null;
      evidenceDigest: string;
      adjudicationVersion: number;
    }
  | { ok: false; detail: string };

/** Replay completo de un caso ya persistido. */
export async function replayStoredJudgeCase(input: {
  organizationId: string;
  testCaseId: string;
}): Promise<LabReplayResult> {
  const replayInput = await loadLabReplayInput(input);
  if (!replayInput) {
    return {
      ok: false,
      detail: `replay_input_incomplete: falta transcript, action trace, evidence snapshot o registro del juez para ${input.testCaseId}`,
    };
  }

  const evidenceIntegrity = verifyEvidenceSnapshot(replayInput.evidence);
  if (!evidenceIntegrity.ok) {
    return { ok: false, detail: evidenceIntegrity.detail };
  }

  const recordIntegrity = verifyJudgeRecord(replayInput.record);
  if (!recordIntegrity.ok) {
    return { ok: false, detail: recordIntegrity.detail };
  }

  if (
    replayInput.record.evidenceDigest !== "" &&
    replayInput.record.evidenceDigest !== replayInput.evidence.digest
  ) {
    return {
      ok: false,
      detail: `judge_evidence_digest_mismatch: registro=${replayInput.record.evidenceDigest} snapshot=${replayInput.evidence.digest}`,
    };
  }

  const replayed = replayJudgeVerdict({
    record: replayInput.record,
    transcript: replayInput.transcript,
    actionTrace: replayInput.actionTrace,
    // La evidencia congelada es la que el juez leyó: el grounding depende de ella.
    evidenceText: replayInput.evidence.kbText,
  });
  if (!replayed.ok) {
    return { ok: false, detail: replayed.detail };
  }

  return {
    ok: true,
    verdict: replayed.verdict,
    matches: replayed.matches,
    verdictDigest: replayed.verdictDigest,
    storedVerdictDigest: replayInput.record.verdictDigest,
    evidenceDigest: replayInput.evidence.digest,
    adjudicationVersion: replayInput.record.version,
  };
}
