import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("próxima acción comercial", () => {
  it("persiste tipo, fecha y nota en lead", () => {
    const schema = source("src/lib/db/schema.ts");
    const migration = source("drizzle/0027_lead_next_action.sql");

    expect(schema).toContain('nextActionType: text("next_action_type"');
    expect(schema).toContain('nextActionAt: timestamp("next_action_at")');
    expect(schema).toContain('nextActionNote: text("next_action_note")');
    expect(migration).toContain('CREATE INDEX "lead_org_next_action_idx"');
  });

  it("expone y actualiza la próxima acción por API", () => {
    const board = source("src/app/api/pipeline/board/route.ts");
    const route = source("src/app/api/pipeline/leads/[id]/route.ts");

    expect(board).toContain("nextActionType: r.lead.nextActionType");
    expect(board).toContain("nextActionAt: r.lead.nextActionAt?.toISOString()");
    expect(route).toContain("nextActionType: z");
    expect(route).toContain("nextActionAt: z.string().datetime()");
    expect(route).toContain("extra.nextActionAt");
  });

  it("permite editar la próxima acción desde el trato", () => {
    const drawer = source("src/components/pipeline/lead-drawer.tsx");
    const pipeline = source("src/components/pipeline/pipeline-client.tsx");

    expect(drawer).toContain("Próxima acción");
    expect(drawer).toContain("Guardar próxima acción");
    expect(drawer).toContain('type="datetime-local"');
    expect(pipeline).toContain("guardarProximaAccion");
    expect(pipeline).toContain("nextActionOverdue");
    expect(pipeline).toContain("Vencida · ");
  });

  it("mide leads sin acción y seguimientos vencidos", () => {
    const metrics = source("src/server/dashboard/metrics.ts");
    const page = source("src/app/(app)/dashboard/page.tsx");

    expect(metrics).toContain("without_next_action");
    expect(metrics).toContain("overdue_next_action");
    expect(metrics).toContain("leadsWithoutNextAction");
    expect(metrics).toContain("overdueNextActions");
    expect(page).toContain("Sin próxima acción");
    expect(page).toContain("Seguimientos vencidos");
  });
});
