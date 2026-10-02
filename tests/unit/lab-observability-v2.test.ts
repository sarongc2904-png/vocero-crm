import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const retrieveRelevantDocumentChunks = vi.fn();

vi.mock("@/server/kb/documents/retrieval", () => ({
  retrieveRelevantDocumentChunks: (...args: unknown[]) =>
    retrieveRelevantDocumentChunks(...args),
}));

import {
  canonicalDigest,
  canonicalJson,
  freezeJson,
  sha256Hex,
} from "@/server/lab/digest";
import {
  ACTION_TRACE_VERSION,
  actionTraceDigest,
  canonicalActions,
  normalizeActionTrace,
  type AgentActionTrace,
} from "@/server/lab/action-trace";
import {
  JUDGE_EVIDENCE_MAX_CHARACTERS,
  JUDGE_EVIDENCE_MAX_CHUNKS,
  bindEvidenceToTrace,
  collectJudgeEvidence,
  verifyEvidenceSnapshot,
  type EvidenceSnapshot,
} from "@/server/lab/evidence-snapshot";

const precioChunk = {
  id: "chunk-precios",
  documentId: "doc-dental",
  content: "Limpieza dental: $700 MXN.",
  position: 0,
  page: null,
  score: 10,
};

const bracketsChunk = {
  id: "chunk-brackets",
  documentId: "doc-dental",
  content: "Brackets metálicos: desde $8,000 MXN.",
  position: 1,
  page: 2,
  score: 8,
};

describe("serialización canónica", () => {
  it("ordena las claves para que el mismo valor dé la misma cadena", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("respeta el orden de los arrays, que sí es significativo", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("el digest es sha256 de la forma canónica", () => {
    expect(canonicalDigest({ a: 1 })).toBe(sha256Hex('{"a":1}'));
    expect(canonicalDigest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("freezeJson desacopla la copia del original", () => {
    const original = { nested: { value: 1 } };
    const copy = freezeJson(original);
    copy.nested.value = 99;
    expect(original.nested.value).toBe(1);
  });
});

describe("Action Trace v2", () => {
  const legacyTrace: AgentActionTrace = [
    {
      turn: 1,
      customerMessage: "¿Qué horarios hay?",
      agentMessages: ["Tengo 09:00 y 09:30."],
      observedActions: ["offer_slots", "reply"],
      result: {
        handoffReason: null,
        contactNotesChanged: false,
        stageChanged: null,
        bookingCreated: true,
      },
    },
  ];

  it("expone la versión v2", () => {
    expect(ACTION_TRACE_VERSION).toBe(2);
  });

  it("normaliza un trace v1 rellenando los campos v2 sin perder nada", () => {
    const [entry] = normalizeActionTrace(legacyTrace);

    expect(entry).toBeDefined();
    expect(entry!.customerMessageId).toBeNull();
    expect(entry!.agentMessageIds).toEqual([]);
    expect(entry!.offeredSlotIds).toEqual([]);
    expect(entry!.bookingIds).toEqual([]);
    expect(entry!.evidenceDigest).toBeNull();
    // El contenido v1 se conserva intacto.
    expect(entry!.agentMessages).toEqual(["Tengo 09:00 y 09:30."]);
    expect(entry!.result.bookingCreated).toBe(true);
  });

  it("fija el orden canónico de las acciones observadas", () => {
    expect(canonicalActions(["book_slot", "reply", "handoff"])).toEqual([
      "reply",
      "handoff",
      "book_slot",
    ]);
    const [entry] = normalizeActionTrace(legacyTrace);
    expect(entry!.observedActions).toEqual(["reply", "offer_slots"]);
  });

  it("elimina acciones duplicadas", () => {
    expect(canonicalActions(["reply", "reply"])).toEqual(["reply"]);
  });

  it("el digest cambia cuando cambia el contenido y es estable si no", () => {
    const first = actionTraceDigest(legacyTrace);
    expect(actionTraceDigest(legacyTrace)).toBe(first);

    const changed = normalizeActionTrace(legacyTrace).map((entry) => ({
      ...entry,
      agentMessages: ["Tengo 10:00."],
    }));
    expect(actionTraceDigest(changed)).not.toBe(first);
  });
});

describe("Evidence Snapshot", () => {
  beforeEach(() => retrieveRelevantDocumentChunks.mockReset());

  async function collect(): Promise<EvidenceSnapshot> {
    retrieveRelevantDocumentChunks
      .mockResolvedValueOnce([precioChunk])
      .mockResolvedValueOnce([precioChunk, bracketsChunk]);

    return collectJudgeEvidence({
      organizationId: "org_dental",
      baseKbText: "KB tradicional",
      transcript: [
        { role: "cliente", text: "¿Cuánto cuesta?" },
        { role: "agente", text: "La limpieza cuesta $700 MXN." },
        { role: "cliente", text: "¿Y los brackets?" },
      ],
    });
  }

  it("recupera por cada mensaje del cliente con los límites del juez", async () => {
    await collect();

    expect(retrieveRelevantDocumentChunks).toHaveBeenCalledTimes(2);
    expect(retrieveRelevantDocumentChunks).toHaveBeenNthCalledWith(1, {
      organizationId: "org_dental",
      query: "¿Cuánto cuesta?",
      maxChunks: JUDGE_EVIDENCE_MAX_CHUNKS,
      maxCharacters: JUDGE_EVIDENCE_MAX_CHARACTERS,
    });
    expect(retrieveRelevantDocumentChunks).toHaveBeenNthCalledWith(2, {
      organizationId: "org_dental",
      query: "¿Y los brackets?",
      maxChunks: JUDGE_EVIDENCE_MAX_CHUNKS,
      maxCharacters: JUDGE_EVIDENCE_MAX_CHARACTERS,
    });
  });

  it("congela la evidencia con el texto y los digests del turno", async () => {
    const snapshot = await collect();

    expect(snapshot.version).toBe(1);
    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.turns[0]!.turn).toBe(1);
    expect(snapshot.turns[0]!.query).toBe("¿Cuánto cuesta?");
    expect(snapshot.turns[1]!.chunks).toHaveLength(2);

    expect(snapshot.kbText).toContain("KB tradicional");
    expect(snapshot.kbText).toContain("Limpieza dental: $700 MXN.");
    expect(snapshot.kbText).toContain("Brackets metálicos: desde $8,000 MXN.");
    // El mismo fragmento recuperado en dos turnos no se duplica.
    expect(snapshot.kbText.match(/Limpieza dental: \$700 MXN\./g)).toHaveLength(1);

    expect(snapshot.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.turns[0]!.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.turns[0]!.digest).not.toBe(snapshot.turns[1]!.digest);
    expect(verifyEvidenceSnapshot(snapshot)).toEqual({ ok: true });
  });

  it("el mismo retrieval produce el mismo digest", async () => {
    const first = await collect();
    const second = await collect();
    expect(second.digest).toBe(first.digest);
  });

  it("detecta un snapshot editado después de congelarse", async () => {
    const snapshot = await collect();
    const tampered: EvidenceSnapshot = {
      ...snapshot,
      turns: snapshot.turns.map((turn) => ({
        ...turn,
        chunks: turn.chunks.map((chunk) => ({
          ...chunk,
          content: `${chunk.content} (editado)`,
        })),
      })),
    };

    const verified = verifyEvidenceSnapshot(tampered);
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.detail).toContain("evidence_digest_mismatch");
    }
  });

  it("detecta un turno editado aunque se recalcule el digest global", async () => {
    const snapshot = await collect();
    const turns = snapshot.turns.map((turn) => ({
      ...turn,
      chunks: turn.chunks.map((chunk) => ({
        ...chunk,
        content: `${chunk.content} (editado)`,
      })),
    }));
    // Se recalcula el digest de nivel superior para que la única incoherencia
    // posible sea la del turno.
    const tampered: EvidenceSnapshot = {
      ...snapshot,
      turns,
      digest: canonicalDigest({
        version: snapshot.version,
        baseKbText: snapshot.baseKbText,
        turns,
      }),
    };

    const verified = verifyEvidenceSnapshot(tampered);
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.detail).toContain("evidence_turn_digest_mismatch");
    }
  });

  it("enlaza cada turno del trace con el digest de su evidencia", async () => {
    const snapshot = await collect();
    const trace: AgentActionTrace = [
      {
        turn: 1,
        customerMessage: "¿Cuánto cuesta?",
        agentMessages: ["La limpieza cuesta $700 MXN."],
        observedActions: ["reply"],
        result: {
          handoffReason: null,
          contactNotesChanged: false,
          stageChanged: null,
          bookingCreated: false,
        },
      },
      {
        turn: 2,
        customerMessage: "Un mensaje que no está en el snapshot",
        agentMessages: [],
        observedActions: [],
        result: {
          handoffReason: null,
          contactNotesChanged: false,
          stageChanged: null,
          bookingCreated: false,
        },
      },
    ];

    const bound = bindEvidenceToTrace(trace, snapshot);

    expect(bound[0]!.evidenceDigest).toBe(snapshot.turns[0]!.digest);
    // El segundo turno no cuadra con la evidencia: se deja nulo en vez de mentir.
    expect(bound[1]!.evidenceDigest).toBeNull();
  });
});

describe("migración 0036", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "drizzle/0036_agent_observability_v2.sql"),
    "utf8"
  );

  it("crea la tabla del Evidence Snapshot con clave tenant y de caso", () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "agent_test_evidence_snapshot"');
    expect(migration).toContain('"organization_id"');
    expect(migration).toContain('"test_case_id"');
    expect(migration).toContain('"evidence_digest"');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "agent_test_evidence_snapshot_org_case_uq"'
    );
  });

  it("añade versión y digest al action trace existente", () => {
    expect(migration).toContain('ALTER TABLE "agent_test_action_trace"');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "version"');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "digest"');
  });

  it("respalda la FK simple con una FK compuesta tenant-aware", () => {
    // El gate de release exige que toda tabla tenant-aware con FK simple tenga
    // además una FK (organization_id, columna) validada.
    expect(migration).toContain(
      'CONSTRAINT "agent_test_evidence_snapshot_test_case_id_tenant_fk"'
    );
    expect(migration).toContain(
      'FOREIGN KEY ("organization_id", "test_case_id")'
    );
    expect(migration).toContain('REFERENCES "agent_test_case" ("organization_id", "id")');
    // Sin NOT VALID: la tabla nace vacía y la constraint queda validada.
    expect(migration).not.toContain("NOT VALID");
  });
});
