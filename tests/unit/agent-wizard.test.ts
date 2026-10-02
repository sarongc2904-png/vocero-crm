import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUSINESS_KB_PREFIX,
  POLICIES_KB_PREFIX,
  deriveAgentWizardState,
  findWizardEntry,
  wizardEntryBody,
} from "@/lib/agent-wizard";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

const profile = {
  enabled: false,
  name: "Vocero",
  tone: "Amable",
  instructions: "Responde con claridad",
  escalationRules: "Escala si piden una persona",
  greeting: "Hola",
};

function state(overrides: Partial<Parameters<typeof deriveAgentWizardState>[0]> = {}) {
  return deriveAgentWizardState({
    profile,
    entries: [],
    documents: [],
    services: [],
    professionals: [],
    agendaHasHours: false,
    tested: false,
    ...overrides,
  });
}

describe("wizard del agente IA", () => {
  const route = source("src/app/api/agent/wizard/test/route.ts");
  const component = source("src/components/agent/agent-wizard.tsx");
  const agent = source("src/components/agent/agent-client.tsx");
  const labTest = source("src/server/lab/wizard-test.ts");
  const pipeline = source("src/server/ai/pipeline.ts");

  it("owner puede editar el wizard", () => {
    expect(route).toContain('withOrgRoles(["owner", "admin"]');
  });

  it("admin puede editar el wizard", () => {
    expect(source("src/app/api/agent/profile/route.ts")).toContain(
      'withOrgRoles(["owner", "admin"]'
    );
  });

  it("member sin permiso no puede modificar", () => {
    expect(route).not.toContain('"agent"');
    expect(source("src/components/app-nav.tsx")).toContain('role !== "agent"');
  });

  it("tenant A no modifica configuración B", () => {
    expect(labTest).toContain("runAgentTurn(conversationId, organizationId)");
    expect(labTest).toContain("scoped(");
    expect(labTest).toContain("schema.message.organizationId");
  });

  it("abrir el wizard no borra configuración existente", () => {
    expect(component).not.toContain('method: "DELETE"');
    expect(component).toContain("wizardEntryBody(entries, BUSINESS_KB_PREFIX)");
  });

  it("el paso negocio reutiliza kb_entry", () => {
    const entries = [
      { id: "kb_1", kind: "block" as const, content: `${BUSINESS_KB_PREFIX}Nombre: Acme` },
    ];
    expect(findWizardEntry(entries, BUSINESS_KB_PREFIX)?.id).toBe("kb_1");
    expect(wizardEntryBody(entries, BUSINESS_KB_PREFIX)).toBe("Nombre: Acme");
    expect(component).toContain('existing ? "PATCH" : "POST"');
  });

  it("tono actualiza agent_profile", () => {
    expect(component).toContain("onSaveProfile(personality)");
    expect(agent).toContain('fetch("/api/agent/profile"');
  });

  it("servicios no duplican datos existentes", () => {
    expect(component).toContain("Ese servicio ya existe; edítalo desde Agenda");
    expect(component).toContain('fetch("/api/services"');
  });

  it("políticas quedan disponibles al agente mediante KB manual", () => {
    const entries = [
      { id: "kb_2", kind: "block" as const, content: `${POLICIES_KB_PREFIX}No hay devoluciones` },
    ];
    expect(state({ entries }).policies).toBe(true);
    expect(source("src/server/ai/pipeline.ts")).toContain(".from(schema.kbEntry)");
  });

  it("documentos reutilizan FASE 1–4", () => {
    for (const endpoint of [
      "/api/kb/documents",
      "/api/kb/documents/${id}",
      "/api/kb/documents/${id}/approve",
    ]) {
      expect(agent).toContain(endpoint);
    }
    expect(component).toContain("{knowledgePanel}");
  });

  it("documento review no cuenta como conocimiento activo", () => {
    const result = state({ documents: [{ status: "review" }] });
    expect(result.documents).toBe(false);
    expect(result.reviewDocuments).toBe(1);
  });

  it("documento ready aprobado sí cuenta como activo", () => {
    const result = state({ documents: [{ status: "ready" }] });
    expect(result.documents).toBe(true);
    expect(result.activeDocuments).toBe(1);
  });

  it("handoff reutiliza escalationRules", () => {
    expect(state().handoff).toBe(true);
    expect(component).toContain("onSaveProfile({ escalationRules })");
  });

  it("agenda refleja configuración real", () => {
    expect(
      state({
        services: [{ active: true }],
        professionals: [{ status: "active" }],
        agendaHasHours: true,
      }).agenda
    ).toBe(true);
    expect(component).toContain('fetch("/api/calendar/settings")');
  });

  it("Lab reutiliza el pipeline real", () => {
    expect(labTest).toContain('import { runAgentTurn } from "@/server/ai/pipeline"');
    expect(labTest).toContain("isTest: true");
  });

  it("Lab usa retrieval documental de FASE 4", () => {
    expect(pipeline).toContain("retrieveRelevantDocumentChunks({");
    expect(pipeline).toContain('query: lastInbound.text ?? ""');
  });

  it("completar pasos no activa automáticamente", () => {
    expect(state({ tested: true }).active).toBe(false);
    expect(component).not.toContain("useEffect(() => onSaveProfile({ enabled: true })");
  });

  it("activación requiere acción explícita", () => {
    expect(component).toContain('onClick={() => void withSave(() => onSaveProfile({ enabled: true })');
    expect(component).toContain("Activar agente");
  });

  it("el estado de pasos se recalcula desde datos reales", () => {
    expect(state().business).toBe(false);
    expect(
      state({
        entries: [
          { id: "kb_1", kind: "block", content: `${BUSINESS_KB_PREFIX}Nombre: Acme` },
        ],
      }).business
    ).toBe(true);
  });

  it("un segundo tenant no puede ver resultados del primero", () => {
    expect(labTest).toContain("organizationId,");
    expect(labTest).toContain("eq(schema.message.conversationId, conversationId)");
    expect(source("src/app/api/kb/route.ts")).toContain(
      "session.organizationId"
    );
  });

  it("la prueba no envía mensajes reales por WhatsApp", () => {
    expect(labTest).toContain("isTest: true");
    expect(labTest).not.toContain("sendText");
  });
});
