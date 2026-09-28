"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  CalendarPlus,
  ChevronRight,
  Kanban,
  Sparkles,
  UserRound,
  Users,
} from "lucide-react";
import type {
  ConversationDto,
  FichaDto,
  FichaValue,
  StageDto,
} from "@/lib/types";
import { cn, formatPhone } from "@/lib/utils";
import { ContactAvatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FichaPanel } from "@/components/ficha-panel";
import { AssignmentControl } from "./assignment-control";
import { QuickBookingDialog } from "./quick-booking-dialog";

const HANDOFF_LABELS: Record<string, string> = {
  cliente: "El cliente pidió un humano",
  modelo: "El agente decidió escalar",
  error: "Error del proveedor de IA",
  ventana: "Ventana de 24h cerrada",
  manual_reply: "Respondiste desde el teléfono — IA en pausa",
};

export function ContactPanel({
  conversation,
  agenda = false,
  refreshKey = 0,
  onPatchConversation,
  onClose,
}: {
  conversation: ConversationDto;
  agenda?: boolean;
  refreshKey?: number;
  onPatchConversation: (patch: {
    aiEnabled?: boolean;
    reactivate?: boolean;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState("");
  const [ficha, setFicha] = useState<FichaDto>({});
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [stages, setStages] = useState<StageDto[]>([]);
  const [currentStageId, setCurrentStageId] = useState<string | null>(null);
  const [leadId, setLeadId] = useState<string | null>(null);
  const [agentEnabled, setAgentEnabled] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [bookingOpen, setBookingOpen] = useState(false);

  const contactId = conversation.contact.id;
  const agentReady = aiConfigured && agentEnabled;
  const aiActive = conversation.aiEnabled && !conversation.handoffAt;

  const refetch = useCallback(async () => {
    const [detail, stagesRes, agentRes] = await Promise.all([
      fetch(`/api/contacts/${contactId}`).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/pipeline/stages").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/agent/profile").then((r) => (r.ok ? r.json() : null)),
    ]).catch(() => [null, null, null]);
    if (detail) {
      setNotes(detail.contact?.notes ?? "");
      setFicha(detail.contact?.ficha ?? {});
      setCurrentStageId(detail.stage?.id ?? null);
      setLeadId(detail.lead?.id ?? null);
    }
    if (stagesRes) setStages(stagesRes.stages);
    setAgentEnabled(Boolean(agentRes?.profile?.enabled));
    setAiConfigured(Boolean(agentRes?.aiConfigured));
    setNotesLoaded(true);
  }, [contactId]);

  const refreshLive = useCallback(async () => {
    const [detail, agentRes] = await Promise.all([
      fetch(`/api/contacts/${contactId}`).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/agent/profile").then((r) => (r.ok ? r.json() : null)),
    ]).catch(() => [null, null]);
    if (detail) {
      setFicha(detail.contact?.ficha ?? {});
      setCurrentStageId(detail.stage?.id ?? null);
      setLeadId(detail.lead?.id ?? null);
    }
    if (agentRes) {
      setAgentEnabled(Boolean(agentRes.profile?.enabled));
      setAiConfigured(Boolean(agentRes.aiConfigured));
    }
  }, [contactId]);

  useEffect(() => {
    setNotesLoaded(false);
    void refetch();
  }, [refetch]);

  useEffect(() => {
    if (!notesLoaded) return;
    void refreshLive();
  }, [refreshKey, notesLoaded, refreshLive]);

  async function moveToStage(stageId: string) {
    if (!leadId || stageId === currentStageId) return;
    setCurrentStageId(stageId);
    await fetch(`/api/pipeline/leads/${leadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stageId, position: 0 }),
    }).catch(() => null);
    void refreshLive();
  }

  async function saveFicha(patch: Record<string, FichaValue | null>) {
    setFicha((prev) => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      return next;
    });
    await fetch(`/api/contacts/${contactId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ficha: patch }),
    }).catch(() => null);
    void refreshLive();
  }

  async function saveNotes() {
    setSavingNotes(true);
    await fetch(`/api/contacts/${contactId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes }),
    }).catch(() => null);
    setSavingNotes(false);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 flex items-center justify-between border-b bg-background px-4 py-3">
        <h3 className="kicker text-text-2">Cliente</h3>
        <button
          onClick={onClose}
          aria-label="Ocultar panel"
          className="rounded p-1 text-text-3 hover:bg-accent hover:text-foreground"
        >
          <ChevronRight className="h-4 w-4" strokeWidth={1.7} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <section className="border-b p-4">
          <div className="flex items-center gap-3">
            <ContactAvatar
              name={conversation.contact.name}
              seed={conversation.contact.id}
              size="md"
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-bold tracking-tight">
                {conversation.contact.name}
              </p>
              <p className="text-xs text-text-3">
                {formatPhone(conversation.contact.phone)}
              </p>
            </div>
          </div>

          {agenda && (
            <Button
              className="mt-3 w-full"
              onClick={() => setBookingOpen(true)}
            >
              <CalendarPlus className="mr-1.5 h-4 w-4" strokeWidth={1.8} />
              Agendar cita
            </Button>
          )}

          <div className="mt-3">
            <p className="kicker mb-2">Responsable</p>
            <AssignmentControl conversationId={conversation.id} />
          </div>

          {stages.length > 0 && leadId && (
            <div className="mt-3">
              <label htmlFor="contact-stage" className="kicker mb-2 block">
                Etapa
              </label>
              <select
                id="contact-stage"
                value={currentStageId ?? ""}
                onChange={(e) => void moveToStage(e.target.value)}
                className="h-10 w-full rounded-md border border-border-strong bg-background px-3 text-sm font-medium"
              >
                {stages.map((stage) => (
                  <option key={stage.id} value={stage.id}>
                    {stage.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {conversation.handoffAt && (
            <div className="mt-3 rounded-md border border-warning-soft bg-warning-tint p-3">
              <p className="flex items-center gap-1.5 text-[13px] font-medium text-warning-text">
                <UserRound className="h-4 w-4" strokeWidth={1.7} /> Atención humana
              </p>
              <p className="mt-1 text-xs text-warning-text opacity-80">
                {HANDOFF_LABELS[conversation.handoffReason ?? ""] ??
                  "La IA está en pausa en esta conversación."}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2 w-full"
                onClick={() => void onPatchConversation({ reactivate: true })}
              >
                Reactivar IA
              </Button>
            </div>
          )}

          <details className="mt-3 rounded-md border bg-subtle">
            <summary className="cursor-pointer list-none px-3 py-2.5 text-[13px] font-medium">
              IA y automatización
              <span className="ml-2 text-[11px] font-normal text-text-3">
                {conversation.handoffAt
                  ? "En pausa"
                  : aiActive
                    ? "Activa"
                    : "En pausa"}
              </span>
            </summary>
            <div className="border-t px-3 py-2.5">

            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">IA en esta conversación</p>
                <p className="text-[11px] text-text-3">
                  {conversation.handoffAt
                    ? "En pausa · atención humana"
                    : !conversation.aiEnabled
                      ? "En pausa"
                      : agentReady
                        ? "Respondiendo"
                        : "Activada"}
                </p>
              </div>
              <button
                role="switch"
                aria-checked={aiActive}
                aria-label="IA en esta conversación"
                onClick={() => {
                  void onPatchConversation({
                    aiEnabled: !conversation.aiEnabled,
                  });
                }}
                className={cn(
                  "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition-colors",
                  aiActive ? "bg-brand" : "bg-border-strong"
                )}
              >
                <span
                  className={cn(
                    "h-4 w-4 rounded-full bg-knob shadow-sm transition-transform",
                    aiActive ? "translate-x-4" : "translate-x-0"
                  )}
                />
              </button>
            </div>

            {!agentReady && (
              <div className="mt-2.5 flex items-start gap-2 rounded-md border border-warning-soft bg-warning-tint p-2.5">
                <Sparkles
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning-text"
                  strokeWidth={1.7}
                />
                <p className="text-[11px] leading-relaxed text-warning-text">
                  {aiConfigured
                    ? "El agente de Conecta Digital no responde por su cuenta. Configura lo básico y enciéndelo (o conecta tu propio bot por la API)."
                    : "Falta la clave de IA de la instancia (OPENROUTER_API_TOKEN) para que el agente responda, o conecta tu propio bot por la API."}
                  {aiConfigured && (
                    <Link
                      href="/agent"
                      className="ml-1 whitespace-nowrap font-medium text-brand-text underline underline-offset-2 hover:text-brand"
                    >
                      Configurar agente →
                    </Link>
                  )}
                </p>
              </div>
            )}
            </div>
          </details>
        </section>

        <details className="border-b">
          <summary className="cursor-pointer list-none px-4 py-3 text-[13px] font-semibold">
            Datos del cliente
          </summary>
          <div className="border-t">
            <FichaPanel ficha={ficha} onSave={saveFicha} />
            <div className="grid grid-cols-2 gap-2 px-4 pb-4">
              <Link
                href="/pipeline"
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-border-strong bg-background px-3 text-xs font-semibold text-text-2 hover:bg-accent"
              >
                <Kanban className="h-3.5 w-3.5" strokeWidth={1.8} />
                Prospectos
              </Link>
              <Link
                href="/contacts"
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-border-strong bg-background px-3 text-xs font-semibold text-text-2 hover:bg-accent"
              >
                <Users className="h-3.5 w-3.5" strokeWidth={1.8} />
                Clientes
              </Link>
            </div>
          </div>
        </details>

        <details>
          <summary className="cursor-pointer list-none px-4 py-3 text-[13px] font-semibold">
            Notas internas
          </summary>
          <section className="border-t p-4">
          <p className="kicker mb-2">Notas</p>
          <Textarea
            rows={5}
            placeholder="Notas internas sobre este contacto…"
            value={notes}
            disabled={!notesLoaded}
            onChange={(e) => setNotes(e.target.value)}
          />
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            disabled={savingNotes || !notesLoaded}
            onClick={() => void saveNotes()}
          >
            {savingNotes ? "Guardando…" : "Guardar notas"}
          </Button>
          </section>
        </details>
      </div>

      {bookingOpen && (
        <QuickBookingDialog
          conversation={conversation}
          onClose={() => setBookingOpen(false)}
          onBooked={() => {
            void refreshLive();
          }}
        />
      )}
    </div>
  );
}
