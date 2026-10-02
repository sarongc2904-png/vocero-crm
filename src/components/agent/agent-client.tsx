"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Eye, FileText, Plus, Settings2, Sparkles, Trash2, Upload } from "lucide-react";
import { AgentWizard } from "@/components/agent/agent-wizard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Profile = {
  enabled: boolean;
  name: string;
  tone: string | null;
  instructions: string | null;
  escalationRules: string | null;
  greeting: string | null;
};

type KbEntry = {
  id: string;
  kind: "qa" | "block";
  question: string | null;
  answer: string | null;
  content: string | null;
};

type KnowledgeDocumentStatus =
  | "uploaded"
  | "processing"
  | "review"
  | "ready"
  | "failed";

type KnowledgeDocument = {
  id: string;
  filename: string;
  mimeType: "text/plain" | "application/pdf";
  fileSize: number;
  status: KnowledgeDocumentStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type KnowledgeDocumentChunk = {
  id: string;
  content: string;
  position: number;
  page: number | null;
  approved: boolean;
};

export function AgentClient() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [aiConfigured, setAiConfigured] = useState(true);
  const [entries, setEntries] = useState<KbEntry[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [kbSize, setKbSize] = useState<{ chars: number; warnAt: number; warning: boolean } | null>(null);
  const [saved, setSaved] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);

  const refetch = useCallback(async () => {
    const [p, kb, size, docs] = await Promise.all([
      fetch("/api/agent/profile").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/kb").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/kb/size").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/kb/documents").then((r) => (r.ok ? r.json() : null)),
    ]).catch(() => [null, null, null, null]);
    if (p) {
      setProfile(p.profile);
      setAiConfigured(p.aiConfigured);
    }
    if (kb) setEntries(kb.entries);
    if (size) setKbSize(size);
    if (docs) setDocuments(docs.documents);
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  if (!profile) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Cargando…
      </div>
    );
  }

  async function saveProfile(patch: Partial<Profile>) {
    const response = await fetch("/api/agent/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error?.message ?? "No se pudo guardar el perfil");
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    await refetch();
  }

  if (wizardOpen) {
    return (
      <div className="h-full overflow-y-auto">
        <AgentWizard
          profile={profile}
          entries={entries}
          documents={documents}
          aiConfigured={aiConfigured}
          onClose={() => setWizardOpen(false)}
          onSaveProfile={saveProfile}
          onChanged={refetch}
          knowledgePanel={
            <KbSection
              entries={entries}
              documents={documents}
              kbSize={kbSize}
              onChanged={() => void refetch()}
            />
          }
        />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 sm:px-6 sm:py-4">
        <h2 className="text-[17px] font-bold tracking-tight">Agente IA</h2>
        <div className="flex items-center gap-3">
          <Button size="sm" variant="outline" onClick={() => setWizardOpen(true)}>
            <Settings2 className="h-4 w-4" /> Configurar agente
          </Button>
          {saved && <span className="text-xs text-primary">Guardado ✓</span>}
          <span className="text-sm text-muted-foreground">
            {profile.enabled ? "Encendido" : "Apagado"}
          </span>
          <button
            role="switch"
            aria-checked={profile.enabled}
            aria-label="Agente encendido"
            disabled={!aiConfigured}
            onClick={() => void saveProfile({ enabled: !profile.enabled }).catch(() => null)}
            className={`relative h-6 w-11 rounded-full transition-colors disabled:opacity-40 ${
              profile.enabled ? "bg-brand" : "bg-border-strong"
            }`}
          >
            {/*
              `shadow-sm` no es adorno: el pomo es blanco (`--knob`) y sobre el
              fondo encendido se perdía, así que el interruptor parecía una
              pastilla sólida sin control (#53). El de la bandeja ya la
              llevaba; este era el único del producto sin ella. Mismos tokens
              que allí, para que no vuelvan a divergir.
            */}
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-knob shadow-sm transition-transform ${
                profile.enabled ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
      </header>

      {!aiConfigured && (
        <div className="mx-4 mt-4 rounded-lg border border-brand-soft bg-brand-tint p-5 text-center sm:mx-6 sm:mt-6 sm:p-6">
          <Sparkles className="mx-auto mb-2 h-8 w-8 text-primary" />
          <p className="font-medium">La IA todavía no está conectada</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Puedes dejar listo cómo debe responder y qué debe saber. Cuando la conexión de IA
            esté disponible, podrás encender el agente desde esta misma pantalla.
          </p>
        </div>
      )}

      <div className="grid gap-4 p-4 sm:gap-6 sm:p-6 lg:grid-cols-2">
        <ProfileSection profile={profile} onSave={saveProfile} />
        <KbSection
          entries={entries}
          documents={documents}
          kbSize={kbSize}
          onChanged={() => void refetch()}
        />
      </div>
    </div>
  );
}

function ProfileSection({
  profile,
  onSave,
}: {
  profile: Profile;
  onSave: (patch: Partial<Profile>) => Promise<void>;
}) {
  const [form, setForm] = useState(profile);
  useEffect(() => setForm(profile), [profile]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Comportamiento</CardTitle>
        <CardDescription>
          Cómo se presenta y actúa el agente al responder a tus clientes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="agent-name">Nombre del agente</Label>
          <Input
            id="agent-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agent-tone">Tono</Label>
          <Input
            id="agent-tone"
            placeholder="p. ej. cercano y directo, con usted"
            value={form.tone ?? ""}
            onChange={(e) => setForm({ ...form, tone: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agent-instructions">Instrucciones</Label>
          <Textarea
            id="agent-instructions"
            rows={5}
            placeholder="Qué debe y no debe hacer el agente…"
            value={form.instructions ?? ""}
            onChange={(e) => setForm({ ...form, instructions: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agent-escalation">Cuándo pasar a una persona</Label>
          <Textarea
            id="agent-escalation"
            rows={3}
            placeholder="Ej. cuando pidan hablar con alguien, haya una queja o el agente no tenga una respuesta segura…"
            value={form.escalationRules ?? ""}
            onChange={(e) => setForm({ ...form, escalationRules: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agent-greeting">Saludo</Label>
          <Input
            id="agent-greeting"
            placeholder="Saludo para conversaciones nuevas"
            value={form.greeting ?? ""}
            onChange={(e) => setForm({ ...form, greeting: e.target.value })}
          />
        </div>
        <Button onClick={() => void onSave(form)}>Guardar comportamiento</Button>
      </CardContent>
    </Card>
  );
}

function KbSection({
  entries,
  documents,
  kbSize,
  onChanged,
}: {
  entries: KbEntry[];
  documents: KnowledgeDocument[];
  kbSize: { chars: number; warnAt: number; warning: boolean } | null;
  onChanged: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [block, setBlock] = useState("");
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [documentBusy, setDocumentBusy] = useState<string | null>(null);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<{
    document: KnowledgeDocument;
    chunks: KnowledgeDocumentChunk[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function addQa() {
    if (!question.trim() || !answer.trim()) return;
    await fetch("/api/kb", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "qa", question, answer }),
    }).catch(() => null);
    setQuestion("");
    setAnswer("");
    onChanged();
  }

  async function addBlock() {
    if (!block.trim()) return;
    await fetch("/api/kb", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "block", content: block }),
    }).catch(() => null);
    setBlock("");
    onChanged();
  }

  async function remove(id: string) {
    await fetch(`/api/kb/${id}`, { method: "DELETE" }).catch(() => null);
    onChanged();
  }

  async function uploadDocument() {
    if (!documentFile) return;
    setDocumentBusy("upload");
    setDocumentError(null);
    const form = new FormData();
    form.set("file", documentFile);
    try {
      const response = await fetch("/api/kb/documents", {
        method: "POST",
        body: form,
      });
      const body = await response.json();
      if (!response.ok) {
        setDocumentError(body.error?.message ?? "No se pudo subir el documento");
        return;
      }
      setDocumentFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      onChanged();
    } catch {
      setDocumentError("No se pudo subir el documento");
    } finally {
      setDocumentBusy(null);
    }
  }

  async function reviewDocument(id: string) {
    setDocumentBusy(id);
    setDocumentError(null);
    try {
      const response = await fetch(`/api/kb/documents/${id}`);
      const body = await response.json();
      if (!response.ok) {
        setDocumentError(body.error?.message ?? "No se pudo abrir el documento");
        return;
      }
      setReviewing(body);
    } catch {
      setDocumentError("No se pudo abrir el documento");
    } finally {
      setDocumentBusy(null);
    }
  }

  async function approveDocument(id: string) {
    setDocumentBusy(id);
    setDocumentError(null);
    try {
      const response = await fetch(`/api/kb/documents/${id}/approve`, {
        method: "POST",
      });
      const body = await response.json();
      if (!response.ok) {
        setDocumentError(body.error?.message ?? "No se pudo aprobar el documento");
        return;
      }
      setReviewing((current) =>
        current?.document.id === id
          ? {
              document: body.document,
              chunks: current.chunks.map((chunk) => ({
                ...chunk,
                approved: true,
              })),
            }
          : current
      );
      onChanged();
    } catch {
      setDocumentError("No se pudo aprobar el documento");
    } finally {
      setDocumentBusy(null);
    }
  }

  async function removeDocument(document: KnowledgeDocument) {
    if (!window.confirm(`¿Eliminar “${document.filename}” y todo su contenido?`)) {
      return;
    }
    setDocumentBusy(document.id);
    setDocumentError(null);
    try {
      const response = await fetch(`/api/kb/documents/${document.id}`, {
        method: "DELETE",
      });
      const body = await response.json();
      if (!response.ok) {
        setDocumentError(body.error?.message ?? "No se pudo eliminar el documento");
        return;
      }
      if (reviewing?.document.id === document.id) setReviewing(null);
      onChanged();
    } catch {
      setDocumentError("No se pudo eliminar el documento");
    } finally {
      setDocumentBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Conocimiento del negocio</CardTitle>
            <CardDescription>
              Agrega aquí la información que el agente puede usar para responder:
              horarios, precios, políticas y preguntas frecuentes.
            </CardDescription>
          </div>
          {kbSize && (
            <Badge variant={kbSize.warning ? "warning" : "secondary"}>
              {kbSize.chars.toLocaleString("es-MX")} caracteres
            </Badge>
          )}
        </div>
        {kbSize?.warning && (
          <p className="text-xs text-warning-text">
            Hay mucha información guardada. Conviene eliminar contenido repetido
            o que ya no uses para mantener respuestas claras.
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">Pregunta frecuente</p>
          <Input
            placeholder="Pregunta (p. ej. ¿Hacen envíos?)"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <Textarea
            placeholder="Respuesta"
            rows={2}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <Button
            size="sm"
            onClick={() => void addQa()}
            disabled={!question.trim() || !answer.trim()}
          >
            <Plus className="h-4 w-4" /> Agregar respuesta
          </Button>
        </div>

        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">Información adicional</p>
          <Textarea
            placeholder="Horarios, direcciones, políticas…"
            rows={3}
            value={block}
            onChange={(e) => setBlock(e.target.value)}
          />
          <Button size="sm" onClick={() => void addBlock()} disabled={!block.trim()}>
            <Plus className="h-4 w-4" /> Agregar información
          </Button>
        </div>

        <ul className="space-y-2">
          {entries.map((e) => (
            <li key={e.id} className="flex items-start gap-2 rounded-md border p-3">
              <div className="min-w-0 flex-1 text-sm">
                {e.kind === "qa" ? (
                  <>
                    <p className="font-medium">{e.question}</p>
                    <p className="mt-0.5 text-muted-foreground">{e.answer}</p>
                  </>
                ) : (
                  <p className="whitespace-pre-wrap text-muted-foreground">{e.content}</p>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Eliminar entrada"
                onClick={() => void remove(e.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
          {entries.length === 0 && (
            <p className="py-2 text-center text-xs text-muted-foreground">
              Sin entradas todavía: agrega lo que el agente debe saber.
            </p>
          )}
        </ul>

        <div className="space-y-3 border-t pt-5">
          <div>
            <p className="text-sm font-semibold">Documentos</p>
            <p className="text-xs text-muted-foreground">
              Sube TXT o PDF. Revisa los fragmentos antes de activarlos.
            </p>
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <Label htmlFor="knowledge-document">Archivo TXT o PDF</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                ref={fileInputRef}
                id="knowledge-document"
                type="file"
                accept=".txt,.pdf,text/plain,application/pdf"
                onChange={(event) =>
                  setDocumentFile(event.target.files?.[0] ?? null)
                }
              />
              <Button
                type="button"
                size="sm"
                className="shrink-0"
                disabled={!documentFile || documentBusy === "upload"}
                onClick={() => void uploadDocument()}
              >
                <Upload className="h-4 w-4" />
                {documentBusy === "upload" ? "Procesando…" : "Subir documento"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Máximo 10 MB.</p>
          </div>

          {documentError && (
            <p role="alert" className="rounded-md bg-danger-tint p-3 text-xs text-danger-text">
              {documentError}
            </p>
          )}

          <ul className="space-y-2">
            {documents.map((document) => {
              const status = documentStatus(document.status);
              return (
                <li key={document.id} className="rounded-md border p-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <FileText className="hidden h-5 w-5 shrink-0 text-muted-foreground sm:block" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{document.filename}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatFileSize(document.fileSize)} ·{" "}
                        {new Date(document.createdAt).toLocaleDateString("es-MX")}
                      </p>
                    </div>
                    <Badge variant={status.variant}>{status.label}</Badge>
                    <div className="flex gap-1 self-end sm:self-auto">
                      {(document.status === "review" || document.status === "ready") && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={documentBusy === document.id}
                          onClick={() => void reviewDocument(document.id)}
                        >
                          <Eye className="h-4 w-4" /> Revisar
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Eliminar ${document.filename}`}
                        disabled={documentBusy === document.id}
                        onClick={() => void removeDocument(document)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  {document.status === "failed" && document.error && (
                    <p className="mt-2 text-xs text-danger-text">{document.error}</p>
                  )}
                </li>
              );
            })}
            {documents.length === 0 && (
              <p className="py-2 text-center text-xs text-muted-foreground">
                No hay documentos cargados.
              </p>
            )}
          </ul>

          {reviewing && (
            <div className="space-y-3 rounded-md border border-brand-soft bg-brand-tint p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">Revisión: {reviewing.document.filename}</p>
                  <p className="text-xs text-muted-foreground">
                    {reviewing.chunks.length} fragmentos extraídos
                  </p>
                </div>
                <div className="flex gap-2">
                  {reviewing.document.status === "review" && (
                    <Button
                      type="button"
                      size="sm"
                      disabled={documentBusy === reviewing.document.id}
                      onClick={() => void approveDocument(reviewing.document.id)}
                    >
                      <Check className="h-4 w-4" /> Aprobar y activar
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setReviewing(null)}
                  >
                    Cerrar
                  </Button>
                </div>
              </div>
              <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                {reviewing.chunks.map((chunk) => (
                  <div key={chunk.id} className="rounded-md border bg-background p-3">
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {chunk.page ? `Página ${chunk.page} · ` : ""}
                      Fragmento {chunk.position + 1}
                    </p>
                    <p className="whitespace-pre-wrap text-sm text-foreground">
                      {chunk.content}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function documentStatus(status: KnowledgeDocumentStatus): {
  label: string;
  variant: "secondary" | "warning" | "success" | "destructive";
} {
  if (status === "review") return { label: "Revisión pendiente", variant: "warning" };
  if (status === "ready") return { label: "Activo", variant: "success" };
  if (status === "failed") return { label: "Error", variant: "destructive" };
  return { label: "Procesando", variant: "secondary" };
}
