import { getSql } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import {
  retrieveRelevantDocumentChunks,
  type RetrievedDocumentChunk,
} from "@/server/kb/documents/retrieval";
import { canonicalDigest, freezeJson } from "@/server/lab/digest";
import type { AgentActionTrace, AgentActionTraceEntry } from "@/server/lab/action-trace";
import type { JudgeRecord } from "@/server/lab/judge";

/**
 * Evidence Snapshot — la evidencia EXACTA que vio el juez, congelada.
 *
 * Antes de v2 el conocimiento del juez se recalculaba en el momento de juzgar:
 * `retrieveRelevantDocumentChunks` volvía a correr sobre la conversación. Dos
 * consecuencias: (a) el prompt del juez no era reproducible (un cambio en los
 * documentos, o incluso el orden de las filas, cambiaba el texto), y (b) no
 * quedaba rastro de con qué información se había juzgado.
 *
 * El snapshot fija, para cada mensaje del cliente, la consulta exacta y los
 * fragmentos recuperados (id, documento, contenido, posición, página, score)
 * en el orden en que el retrieval los devolvió, más el texto final que se
 * inyecta al prompt. Todo con digests SHA-256 para poder verificar después que
 * nada se alteró.
 */

export const EVIDENCE_SNAPSHOT_VERSION = 1;

/** Límites del retrieval del juez: NO cambiar sin subir la versión del snapshot. */
export const JUDGE_EVIDENCE_MAX_CHUNKS = 5;
export const JUDGE_EVIDENCE_MAX_CHARACTERS = 7_500;

export type EvidenceTurn = {
  turn: number;
  query: string;
  chunks: RetrievedDocumentChunk[];
  digest: string;
};

export type EvidenceSnapshot = {
  version: number;
  baseKbText: string;
  baseKbDigest: string;
  turns: EvidenceTurn[];
  /** Texto exacto que se inyecta al prompt del juez. */
  kbText: string;
  /** Digest de los HECHOS del snapshot (no del texto derivado). */
  digest: string;
};

/** Copia solo los campos que forman parte del contrato del retrieval. */
function snapshotChunk(chunk: RetrievedDocumentChunk): RetrievedDocumentChunk {
  return {
    id: chunk.id,
    documentId: chunk.documentId,
    content: chunk.content,
    position: chunk.position,
    page: chunk.page,
    score: chunk.score,
  };
}

/**
 * Recorre el transcript, recupera conocimiento documental por cada mensaje del
 * cliente y devuelve el snapshot congelado.
 *
 * Se conserva el comportamiento histórico de `buildJudgeKnowledgeText`: mismo
 * orden de consultas, mismos límites y deduplicación por id de fragmento en el
 * texto final.
 */
export async function collectJudgeEvidence(input: {
  organizationId: string;
  baseKbText: string;
  transcript: { role: "cliente" | "agente"; text: string }[];
}): Promise<EvidenceSnapshot> {
  const seen = new Map<string, string>();
  const turns: EvidenceTurn[] = [];
  let turn = 0;

  for (const message of input.transcript) {
    if (message.role !== "cliente" || !message.text.trim()) continue;

    turn += 1;
    const retrieved = await retrieveRelevantDocumentChunks({
      organizationId: input.organizationId,
      query: message.text,
      maxChunks: JUDGE_EVIDENCE_MAX_CHUNKS,
      maxCharacters: JUDGE_EVIDENCE_MAX_CHARACTERS,
    });

    const chunks = retrieved.map(snapshotChunk);
    turns.push({
      turn,
      query: message.text,
      chunks,
      digest: canonicalDigest({ turn, query: message.text, chunks }),
    });

    for (const chunk of retrieved) {
      if (!seen.has(chunk.id)) seen.set(chunk.id, chunk.content);
    }
  }

  const kbText = [
    input.baseKbText.trim(),
    [...seen.values()].join("\n\n").trim(),
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    version: EVIDENCE_SNAPSHOT_VERSION,
    baseKbText: input.baseKbText,
    baseKbDigest: canonicalDigest(input.baseKbText),
    turns,
    kbText,
    // El digest cubre los hechos: la versión, la KB base y cada turno. `kbText`
    // es una proyección determinista de ellos, así que no se incluye.
    digest: canonicalDigest({
      version: EVIDENCE_SNAPSHOT_VERSION,
      baseKbText: input.baseKbText,
      turns,
    }),
  };
}

/**
 * Enlaza cada entrada del trace con el digest de la evidencia de su turno.
 *
 * El emparejamiento es por texto del mensaje del cliente y en orden, no por
 * posición ciega: si algo no cuadra se deja `null` en vez de mentir. Función
 * pura.
 */
export function bindEvidenceToTrace(
  trace: AgentActionTrace,
  snapshot: EvidenceSnapshot
): AgentActionTraceEntry[] {
  let cursor = 0;
  return trace.map((entry) => {
    const turn = snapshot.turns[cursor];
    if (turn !== undefined && turn.query === entry.customerMessage) {
      cursor += 1;
      return { ...entry, evidenceDigest: turn.digest };
    }
    return { ...entry, evidenceDigest: null };
  });
}

export type PersistedEvidenceSnapshot = {
  version: number;
  adjudicationVersion: number;
  snapshot: EvidenceSnapshot;
  evidenceDigest: string;
  judgeRecord: JudgeRecord | null;
  judgeInputDigest: string | null;
  verdictDigest: string | null;
  status: string | null;
};

/**
 * Persiste el snapshot y, si el juez ya corrió, su registro reproducible.
 * La clave compuesta (organización, caso) evita sobrescribir otro tenant.
 */
export async function persistEvidenceSnapshot(input: {
  organizationId: string;
  testCaseId: string;
  snapshot: EvidenceSnapshot;
  adjudicationVersion: number;
  judgeRecord?: JudgeRecord | null;
}): Promise<void> {
  const sql = getSql();
  const record = input.judgeRecord ?? null;
  const snapshotJson = JSON.stringify(input.snapshot);

  await sql`
    INSERT INTO agent_test_evidence_snapshot (
      id,
      organization_id,
      test_case_id,
      version,
      adjudication_version,
      evidence,
      evidence_digest,
      judge_record,
      judge_input_digest,
      verdict_digest,
      status,
      updated_at
    ) VALUES (
      ${newId("testEvidence")},
      ${input.organizationId},
      ${input.testCaseId},
      ${input.snapshot.version},
      ${input.adjudicationVersion},
      ${snapshotJson}::jsonb,
      ${input.snapshot.digest},
      ${record ? JSON.stringify(record) : null}::jsonb,
      ${record?.judgeInputDigest ?? null},
      ${record?.verdictDigest ?? null},
      ${record?.status ?? null},
      now()
    )
    ON CONFLICT (organization_id, test_case_id)
    DO UPDATE SET
      version = EXCLUDED.version,
      adjudication_version = EXCLUDED.adjudication_version,
      evidence = EXCLUDED.evidence,
      evidence_digest = EXCLUDED.evidence_digest,
      judge_record = EXCLUDED.judge_record,
      judge_input_digest = EXCLUDED.judge_input_digest,
      verdict_digest = EXCLUDED.verdict_digest,
      status = EXCLUDED.status,
      updated_at = now()
  `;
}

/** Lectura del snapshot: es la entrada del replay offline del juez. */
export async function loadEvidenceSnapshot(input: {
  organizationId: string;
  testCaseId: string;
}): Promise<PersistedEvidenceSnapshot | null> {
  const sql = getSql();
  const rows = (await sql`
    SELECT
      version,
      adjudication_version,
      evidence,
      evidence_digest,
      judge_record,
      judge_input_digest,
      verdict_digest,
      status
    FROM agent_test_evidence_snapshot
    WHERE organization_id = ${input.organizationId}
      AND test_case_id = ${input.testCaseId}
    LIMIT 1
  `) as unknown as Array<{
    version: number | null;
    adjudication_version: number | null;
    evidence: unknown;
    evidence_digest: string | null;
    judge_record: unknown;
    judge_input_digest: string | null;
    verdict_digest: string | null;
    status: string | null;
  }>;

  const row = rows[0];
  if (!row || row.evidence === null || typeof row.evidence !== "object") {
    return null;
  }

  return {
    version: row.version ?? EVIDENCE_SNAPSHOT_VERSION,
    adjudicationVersion: row.adjudication_version ?? 1,
    snapshot: freezeJson(row.evidence as EvidenceSnapshot),
    evidenceDigest: row.evidence_digest ?? "",
    judgeRecord:
      row.judge_record && typeof row.judge_record === "object"
        ? freezeJson(row.judge_record as JudgeRecord)
        : null,
    judgeInputDigest: row.judge_input_digest ?? null,
    verdictDigest: row.verdict_digest ?? null,
    status: row.status ?? null,
  };
}

/**
 * Verificación de integridad: recomputa el digest de los hechos del snapshot y
 * lo compara con el persistido. Detecta cualquier edición posterior.
 */
export function verifyEvidenceSnapshot(
  snapshot: EvidenceSnapshot
): { ok: true } | { ok: false; detail: string } {
  const recomputed = canonicalDigest({
    version: snapshot.version,
    baseKbText: snapshot.baseKbText,
    turns: snapshot.turns,
  });

  if (recomputed !== snapshot.digest) {
    return {
      ok: false,
      detail: `evidence_digest_mismatch: esperado=${snapshot.digest} real=${recomputed}`,
    };
  }

  for (const turn of snapshot.turns) {
    const turnDigest = canonicalDigest({
      turn: turn.turn,
      query: turn.query,
      chunks: turn.chunks,
    });
    if (turnDigest !== turn.digest) {
      return {
        ok: false,
        detail: `evidence_turn_digest_mismatch: turno=${turn.turn}`,
      };
    }
  }

  return { ok: true };
}
