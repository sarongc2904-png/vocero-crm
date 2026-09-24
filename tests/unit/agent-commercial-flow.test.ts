import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "@/server/ai/prompts";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

const profile = {
  name: "Asistente",
  tone: "claro y breve",
  instructions: null,
  escalationRules: null,
  greeting: "Hola, ¿en qué puedo ayudarte?",
} as Parameters<typeof buildAgentSystemPrompt>[0]["profile"];

function commercialPrompt(options?: { repeatedGreeting?: boolean; withPrice?: boolean }) {
  const kb = options?.withPrice
    ? [
        {
          kind: "qa",
          question: "¿Cuánto cuesta el servicio?",
          answer: "El servicio cuesta $1,397 MXN al mes.",
        },
      ]
    : [];

  return buildAgentSystemPrompt({
    profile,
    kb: kb as Parameters<typeof buildAgentSystemPrompt>[0]["kb"],
    stages: [{ name: "Nuevo" }, { name: "Interesado" }],
    agenda: false,
    repeatedGreeting: options?.repeatedGreeting,
  });
}

describe("flujo comercial WhatsApp/IA - release hardening", () => {
  it("responde precios desde el conocimiento sin convertir precio en handoff", () => {
    const prompt = commercialPrompt({ withPrice: true });

    expect(prompt).toContain("El servicio cuesta $1,397 MXN al mes.");
    expect(prompt).toContain("Preguntas normales sobre precio");
    expect(prompt).toContain("NO son handoff por sí solas");
    expect(prompt).toContain("respóndela directamente");
  });

  it("si falta el precio prohíbe inventarlo y también prohíbe escalar automáticamente", () => {
    const prompt = commercialPrompt();

    expect(prompt).toContain("Si preguntan precio/costo y el conocimiento no trae ese dato");
    expect(prompt).toContain("NO inventes ni escales automáticamente");
  });

  it("una petición explícita de humano sí tiene prioridad", () => {
    const prompt = commercialPrompt({ withPrice: true });

    expect(prompt).toContain(
      "Si el cliente pide hablar con una persona/humano/asesor → handoff"
    );
  });

  it("un saludo repetido no reinicia catálogo ni presentación", () => {
    const prompt = commercialPrompt({ repeatedGreeting: true, withPrice: true });

    expect(prompt).toContain("CONTINUIDAD DE ESTE TURNO");
    expect(prompt).toContain("NO reinicies la presentación");
    expect(prompt).toContain("NO repitas el catálogo/servicios");
  });

  it("el handoff explícito se reclama antes de enviar el aviso y queda silenciado", () => {
    const pipeline = source("src/server/ai/pipeline.ts");
    const handoffBlockStart = pipeline.indexOf(
      "if (lastInbound.text && matchesHandoffIntent(lastInbound.text))"
    );
    const claimed = pipeline.indexOf("const claimed = await applyHandoff", handoffBlockStart);
    const notice = pipeline.indexOf(
      "Voy a pasar tu conversación a un asesor",
      handoffBlockStart
    );

    expect(handoffBlockStart).toBeGreaterThan(-1);
    expect(claimed).toBeGreaterThan(handoffBlockStart);
    expect(notice).toBeGreaterThan(claimed);
    expect(pipeline).toContain("eq(schema.conversation.aiEnabled, true)");
    expect(pipeline).toContain("isNull(schema.conversation.handoffAt)");
    expect(pipeline).toContain("aiEnabled: false");
  });

  it("el enqueue del agente coalesce mensajes consecutivos por conversación", () => {
    const queue = source("src/server/jobs/queue.ts");

    expect(queue).toContain("on conflict (conversation_id) do update");
    expect(queue).toContain("requested_at = now()");
    expect(queue).toContain("due_at = excluded.due_at");
  });

  it("un tenant comercialmente inactivo conserva inbound pero no ejecuta IA", () => {
    const ingest = source("src/server/inbox/ingest.ts");
    const trigger = source("src/server/ai/trigger.ts");

    expect(ingest.indexOf(".insert(schema.message)")).toBeLessThan(
      ingest.indexOf("await maybeRunAgentTurn(organizationId, conversation.id)")
    );
    expect(trigger.indexOf("hasCommercialAccess")).toBeLessThan(
      trigger.indexOf("await scheduleAgentTurn")
    );
  });

  it("si agenda está apagada el texto libre del modelo no puede prometer citas", () => {
    const pipeline = source("src/server/ai/pipeline.ts");
    const guard = source("src/server/ai/capability-guard.ts");

    expect(pipeline).toContain("enforceAgentCapabilities");
    expect(pipeline).toContain("safeModelReply(action.text)");
    expect(guard).toContain("AGENDA_DISABLED_SAFE_REPLY");
  });
});
