import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { publish } from "@/server/events/bus";
import { runAgentTurn } from "@/server/ai/pipeline";
import { renderKb } from "@/server/ai/prompts";
import { computeScore, judgeCase } from "@/server/lab/judge";
import { type Persona } from "@/server/lab/personas";
import { getLabPersonas } from "@/server/lab/profile";
import { enqueueLabRun } from "@/server/jobs/queue";
import {
  persistActionTrace,
  type AgentActionTrace,
  type AgentActionTraceEntry,
} from "@/server/lab/action-trace";

/**
 * Runner del Laboratorio (FR-030/FR-034).
 *
 * Wave 3: startRun solo crea el run/casos y encola un job durable en Postgres.
 * Un reinicio ya no convierte automáticamente la corrida en fallida: el worker
 * puede reclamarla de nuevo y continuar los casos aún no terminados.
 */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

export class RunConflictError extends Error {}

export async function startRun(organizationId: string): Promise<string> {
  const db = getDb();
  let runId: string;
  try {
    const inserted = await db
      .insert(schema.agentTestRun)
      .values({ id: newId("testRun"), organizationId, status: "running" })
      .returning();
    runId = inserted[0]!.id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new RunConflictError("Ya hay una corrida en curso");
    }
    throw err;
  }

  const personas = await getLabPersonas(organizationId);

  await db.insert(schema.agentTestCase).values(
    personas.map((p) => ({
      id: newId("testCase"),
      organizationId,
      runId,
      persona: p.key,
      status: "pending" as const,
    }))
  );

  await enqueueLabRun(organizationId, runId);
  return runId;
}

export async function executeLabRun(
  runId: string,
  organizationId: string
): Promise<void> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  try {
    await runAllCases(runId, organizationId, deadline);
  } catch (err) {
    await failRun(runId, organizationId, String(err));
  }
}

async function runAllCases(
  runId: string,
  organizationId: string,
  deadline: number
): Promise<void> {
  const db = getDb();
  const personas = await getLabPersonas(organizationId);
  const cases = await db
    .select()
    .from(schema.agentTestCase)
    .where(
      and(
        eq(schema.agentTestCase.organizationId, organizationId),
        eq(schema.agentTestCase.runId, runId)
      )
    )
    .orderBy(asc(schema.agentTestCase.createdAt));

  const kbEntries = await db
    .select()
    .from(schema.kbEntry)
    .where(eq(schema.kbEntry.organizationId, organizationId));
  const kbText = renderKb(kbEntries);

  const profileRows = await db
    .select()
    .from(schema.agentProfile)
    .where(eq(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  const profile = profileRows[0];
  const behaviorText = profile
    ? [
        `Nombre: ${profile.name}`,
        profile.tone ? `Tono: ${profile.tone}` : null,
        profile.instructions ? `Instrucciones: ${profile.instructions}` : null,
        profile.escalationRules ? `Escalado: ${profile.escalationRules}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  let done = cases.filter(
    (testCase) =>
      testCase.status === "done" || testCase.status === "judge_failed"
  ).length;
  const total = cases.length;
  publishProgress(organizationId, runId, "running", done, total);

  for (const testCase of cases) {
    if (Date.now() > deadline) {
      throw new Error("timeout de 10 minutos superado");
    }
    if (testCase.status === "done" || testCase.status === "judge_failed") {
      continue;
    }

    const persona = personas.find((p) => p.key === testCase.persona);
    if (!persona) {
      done += 1;
      continue;
    }

    await db
      .update(schema.agentTestCase)
      .set({ status: "running" })
      .where(
        and(
          eq(schema.agentTestCase.organizationId, organizationId),
          eq(schema.agentTestCase.runId, runId),
          eq(schema.agentTestCase.id, testCase.id)
        )
      );

    const { transcript, conversationId, actionTrace } = await runConversation(
      organizationId,
      persona
    );

    await persistActionTrace({
      organizationId,
      testCaseId: testCase.id,
      trace: actionTrace,
    });

    const outcome = await judgeCase({
      personaKey: persona.key,
      transcript,
      kbText,
      behaviorText,
      actionTrace,
    });

    await db
      .update(schema.agentTestCase)
      .set({
        conversationId,
        transcript,
        status: outcome.status,
        veredicto: outcome.status === "done" ? outcome.verdict.veredicto : null,
        hallazgos: outcome.status === "done" ? outcome.verdict.hallazgos : null,
      })
      .where(
        and(
          eq(schema.agentTestCase.organizationId, organizationId),
          eq(schema.agentTestCase.runId, runId),
          eq(schema.agentTestCase.id, testCase.id)
        )
      );

    done += 1;
    publishProgress(organizationId, runId, "running", done, total);
  }

  const finalCases = await db
    .select({
      status: schema.agentTestCase.status,
      veredicto: schema.agentTestCase.veredicto,
    })
    .from(schema.agentTestCase)
    .where(
      and(
        eq(schema.agentTestCase.organizationId, organizationId),
        eq(schema.agentTestCase.runId, runId)
      )
    );
  const score = computeScore(finalCases);

  await db
    .update(schema.agentTestRun)
    .set({ status: "done", score, finishedAt: new Date() })
    .where(
      and(
        eq(schema.agentTestRun.organizationId, organizationId),
        eq(schema.agentTestRun.id, runId)
      )
    );
  publishProgress(organizationId, runId, "done", done, total, score);
}

type TraceSnapshot = {
  handoffReason: string | null;
  contactNotes: string | null;
  stageId: string | null;
  bookingIds: string[];
  agentMessages: string[];
};

async function captureTraceSnapshot(input: {
  organizationId: string;
  conversationId: string;
  contactId: string;
}): Promise<TraceSnapshot> {
  const db = getDb();
  const [convRows, contactRows, leadRows, bookingRows, outboundRows] =
    await Promise.all([
      db
        .select({ handoffReason: schema.conversation.handoffReason })
        .from(schema.conversation)
        .where(
          and(
            eq(schema.conversation.organizationId, input.organizationId),
            eq(schema.conversation.id, input.conversationId)
          )
        )
        .limit(1),
      db
        .select({ notes: schema.contact.notes })
        .from(schema.contact)
        .where(
          and(
            eq(schema.contact.organizationId, input.organizationId),
            eq(schema.contact.id, input.contactId)
          )
        )
        .limit(1),
      db
        .select({ stageId: schema.lead.stageId })
        .from(schema.lead)
        .where(
          and(
            eq(schema.lead.organizationId, input.organizationId),
            eq(schema.lead.contactId, input.contactId)
          )
        )
        .limit(1),
      db
        .select({ id: schema.booking.id })
        .from(schema.booking)
        .where(
          and(
            eq(schema.booking.organizationId, input.organizationId),
            eq(schema.booking.conversationId, input.conversationId)
          )
        ),
      db
        .select({ text: schema.message.text })
        .from(schema.message)
        .where(
          and(
            eq(schema.message.organizationId, input.organizationId),
            eq(schema.message.conversationId, input.conversationId),
            eq(schema.message.direction, "out")
          )
        )
        .orderBy(asc(schema.message.createdAt)),
    ]);

  return {
    handoffReason: convRows[0]?.handoffReason ?? null,
    contactNotes: contactRows[0]?.notes ?? null,
    stageId: leadRows[0]?.stageId ?? null,
    bookingIds: bookingRows.map((row) => row.id),
    agentMessages: outboundRows
      .map((row) => row.text)
      .filter((text): text is string => Boolean(text)),
  };
}

function buildTraceEntry(input: {
  turn: number;
  customerMessage: string;
  before: TraceSnapshot;
  after: TraceSnapshot;
}): AgentActionTraceEntry {
  const newAgentMessages = input.after.agentMessages.slice(
    input.before.agentMessages.length
  );
  const contactNotesChanged =
    input.before.contactNotes !== input.after.contactNotes;
  const stageChanged =
    input.before.stageId !== input.after.stageId
      ? { from: input.before.stageId, to: input.after.stageId }
      : null;
  const bookingCreated = input.after.bookingIds.some(
    (id) => !input.before.bookingIds.includes(id)
  );
  const handoffChanged =
    input.before.handoffReason !== input.after.handoffReason &&
    input.after.handoffReason !== null;

  const observedActions: AgentActionTraceEntry["observedActions"] = [];
  if (newAgentMessages.length > 0) observedActions.push("reply");
  if (handoffChanged) observedActions.push("handoff");
  if (contactNotesChanged) observedActions.push("update_lead");
  if (stageChanged) observedActions.push("move_stage");
  if (bookingCreated) observedActions.push("book_slot");

  return {
    turn: input.turn,
    customerMessage: input.customerMessage,
    agentMessages: newAgentMessages,
    observedActions,
    result: {
      handoffReason: input.after.handoffReason,
      contactNotesChanged,
      stageChanged,
      bookingCreated,
    },
  };
}

/** Conversa el guion completo contra el agente real; corta al primer handoff. */
async function runConversation(
  organizationId: string,
  persona: Persona
): Promise<{
  transcript: { role: "cliente" | "agente"; text: string }[];
  conversationId: string;
  actionTrace: AgentActionTrace;
}> {
  const db = getDb();
  const contactId = await upsertTestContact(organizationId, persona);

  const convId = newId("conversation");
  await db.insert(schema.conversation).values({
    id: convId,
    organizationId,
    contactId,
    isTest: true,
    aiEnabled: true,
  });

  const actionTrace: AgentActionTrace = [];
  let turn = 0;

  for (const line of persona.script) {
    turn += 1;
    const now = new Date();
    await db.insert(schema.message).values({
      id: newId("message"),
      organizationId,
      conversationId: convId,
      direction: "in",
      type: "text",
      text: line,
      status: "delivered",
      waTimestamp: now,
    });
    await db
      .update(schema.conversation)
      .set({ lastInboundAt: now, lastMessageAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.conversation.organizationId, organizationId),
          eq(schema.conversation.id, convId)
        )
      );

    const before = await captureTraceSnapshot({
      organizationId,
      conversationId: convId,
      contactId,
    });

    // Expected organization is passed explicitly so a leaked conversation id
    // can never make the Lab operate on a different tenant.
    await runAgentTurn(convId, organizationId);

    const after = await captureTraceSnapshot({
      organizationId,
      conversationId: convId,
      contactId,
    });
    actionTrace.push(
      buildTraceEntry({ turn, customerMessage: line, before, after })
    );

    if (after.handoffReason) break;
  }

  const messages = await db
    .select()
    .from(schema.message)
    .where(
      and(
        eq(schema.message.organizationId, organizationId),
        eq(schema.message.conversationId, convId)
      )
    )
    .orderBy(asc(schema.message.createdAt));

  return {
    conversationId: convId,
    actionTrace,
    transcript: messages
      .filter((m) => m.text)
      .map((m) => ({
        role: m.direction === "in" ? ("cliente" as const) : ("agente" as const),
        text: m.text!,
      })),
  };
}

async function upsertTestContact(
  organizationId: string,
  persona: Persona
): Promise<string> {
  const db = getDb();
  const inserted = await db
    .insert(schema.contact)
    .values({
      id: newId("contact"),
      organizationId,
      phone: persona.phone,
      waIdentity: persona.phone,
      name: persona.contactName,
      archivedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [
        schema.contact.organizationId,
        schema.contact.channel,
        schema.contact.waIdentity,
      ],
    })
    .returning();
  if (inserted[0]) return inserted[0].id;
  const rows = await db
    .select({ id: schema.contact.id })
    .from(schema.contact)
    .where(
      and(
        eq(schema.contact.organizationId, organizationId),
        eq(schema.contact.phone, persona.phone)
      )
    )
    .limit(1);
  if (!rows[0]) throw new Error("No se pudo resolver el contacto de prueba");
  return rows[0].id;
}

async function failRun(
  runId: string,
  organizationId: string,
  error: string
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.agentTestRun)
    .set({ status: "failed", error, finishedAt: new Date() })
    .where(
      and(
        eq(schema.agentTestRun.organizationId, organizationId),
        eq(schema.agentTestRun.id, runId)
      )
    );
  const total = await db
    .select({ id: schema.agentTestCase.id })
    .from(schema.agentTestCase)
    .where(
      and(
        eq(schema.agentTestCase.organizationId, organizationId),
        eq(schema.agentTestCase.runId, runId)
      )
    );
  publishProgress(organizationId, runId, "failed", 0, total.length);
}

function publishProgress(
  organizationId: string,
  runId: string,
  status: string,
  done: number,
  total: number,
  score?: number | null
): void {
  publish(organizationId, {
    type: "lab.run",
    data: { runId, status, progress: { done, total }, score },
  });
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === "23505" || e.cause?.code === "23505";
}
