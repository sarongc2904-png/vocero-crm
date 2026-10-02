"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Circle,
  ExternalLink,
  Play,
  Save,
  X,
} from "lucide-react";
import {
  BUSINESS_KB_PREFIX,
  POLICIES_KB_PREFIX,
  deriveAgentWizardState,
  findWizardEntry,
  wizardEntryBody,
  type WizardKbEntry,
  type WizardProfile,
} from "@/lib/agent-wizard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type WizardDocument = {
  id: string;
  filename: string;
  status: "uploaded" | "processing" | "review" | "ready" | "failed";
};

type Service = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceCents: number;
  currency: string;
  active: boolean;
};

type Professional = { id: string; name: string; status: string };

const STEPS = [
  "Negocio",
  "Tono y personalidad",
  "Servicios y precios",
  "Horarios y políticas",
  "Documentos",
  "Escalamiento a humano",
  "Agenda",
  "Probar agente",
  "Activar",
] as const;

const TONES = ["Profesional", "Amable", "Directo", "Cercano"];

function field(body: string, label: string): string {
  return (
    body
      .split("\n")
      .find((line) => line.startsWith(`${label}: `))
      ?.slice(label.length + 2) ?? ""
  );
}

async function responseError(response: Response, fallback: string) {
  const body = await response.json().catch(() => null);
  return body?.error?.message ?? fallback;
}

export function AgentWizard({
  profile,
  entries,
  documents,
  aiConfigured,
  knowledgePanel,
  onClose,
  onSaveProfile,
  onChanged,
}: {
  profile: WizardProfile;
  entries: WizardKbEntry[];
  documents: WizardDocument[];
  aiConfigured: boolean;
  knowledgePanel: ReactNode;
  onClose: () => void;
  onSaveProfile: (patch: Partial<WizardProfile>) => Promise<void>;
  onChanged: () => Promise<void> | void;
}) {
  const [step, setStep] = useState(0);
  const [services, setServices] = useState<Service[]>([]);
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [agendaHasHours, setAgendaHasHours] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState(false);

  const businessBody = wizardEntryBody(entries, BUSINESS_KB_PREFIX);
  const [business, setBusiness] = useState({
    name: field(businessBody, "Nombre"),
    description: field(businessBody, "Descripción"),
    offer: field(businessBody, "Oferta"),
    essentials: field(businessBody, "Información esencial"),
  });
  const [policies, setPolicies] = useState(
    wizardEntryBody(entries, POLICIES_KB_PREFIX)
  );
  const [personality, setPersonality] = useState({
    name: profile.name,
    tone: profile.tone ?? "",
    instructions: profile.instructions ?? "",
    greeting: profile.greeting ?? "",
  });
  const [escalationRules, setEscalationRules] = useState(
    profile.escalationRules ?? ""
  );
  const [serviceForm, setServiceForm] = useState({
    name: "",
    description: "",
    price: "",
    duration: "60",
  });
  const [testMessage, setTestMessage] = useState("");
  const [testResponse, setTestResponse] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      fetch("/api/services").then((response) =>
        response.ok ? response.json() : { services: [] }
      ),
      fetch("/api/professionals").then((response) =>
        response.ok ? response.json() : { professionals: [] }
      ),
      fetch("/api/calendar/settings").then((response) =>
        response.ok ? response.json() : null
      ),
    ])
      .then(([serviceData, professionalData, calendarData]) => {
        if (!active) return;
        setServices(serviceData.services ?? []);
        setProfessionals(professionalData.professionals ?? []);
        const weeklyHours = calendarData?.settings?.weeklyHours ?? {};
        setAgendaHasHours(
          Object.values(weeklyHours).some(
            (intervals) => Array.isArray(intervals) && intervals.length > 0
          )
        );
      })
      .catch(() => setError("No se pudo consultar el estado de agenda"))
      .finally(() => active && setCatalogLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const state = useMemo(
    () =>
      deriveAgentWizardState({
        profile,
        entries,
        documents,
        services,
        professionals,
        agendaHasHours,
        tested,
      }),
    [profile, entries, documents, services, professionals, agendaHasHours, tested]
  );
  const complete = [
    state.business,
    state.personality,
    state.services,
    state.policies,
    state.documents,
    state.handoff,
    state.agenda,
    state.tested,
    state.active,
  ];

  function showSaved(message: string) {
    setSaved(message);
    setTimeout(() => setSaved(null), 2_000);
  }

  async function saveKbBlock(prefix: string, content: string) {
    const clean = content.trim();
    if (!clean) throw new Error("Completa la información antes de guardar");
    const existing = findWizardEntry(entries, prefix);
    const response = await fetch(existing ? `/api/kb/${existing.id}` : "/api/kb", {
      method: existing ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        existing
          ? { content: `${prefix}${clean}` }
          : { kind: "block", content: `${prefix}${clean}` }
      ),
    });
    if (!response.ok) {
      throw new Error(await responseError(response, "No se pudo guardar"));
    }
    await onChanged();
  }

  async function withSave(action: () => Promise<void>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      showSaved(message);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "No se pudo guardar");
    } finally {
      setBusy(false);
    }
  }

  async function saveBusiness() {
    const content = [
      `Nombre: ${business.name.trim()}`,
      `Descripción: ${business.description.trim()}`,
      `Oferta: ${business.offer.trim()}`,
      `Información esencial: ${business.essentials.trim()}`,
    ].join("\n");
    await saveKbBlock(BUSINESS_KB_PREFIX, content);
  }

  async function addService() {
    const normalized = serviceForm.name.trim().toLocaleLowerCase("es-MX");
    if (services.some((service) => service.name.trim().toLocaleLowerCase("es-MX") === normalized)) {
      throw new Error("Ese servicio ya existe; edítalo desde Agenda");
    }
    const price = Number(serviceForm.price);
    const duration = Number(serviceForm.duration);
    if (!normalized || !Number.isFinite(price) || price < 0) {
      throw new Error("Captura un servicio y un precio válido");
    }
    const response = await fetch("/api/services", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: serviceForm.name.trim(),
        description: serviceForm.description.trim(),
        durationMinutes: duration,
        priceCents: Math.round(price * 100),
        currency: "MXN",
        active: true,
      }),
    });
    if (!response.ok) {
      throw new Error(await responseError(response, "No se pudo crear el servicio"));
    }
    const body = await response.json();
    setServices((current) => [...current, body.service]);
    setServiceForm({ name: "", description: "", price: "", duration: "60" });
  }

  async function runTest() {
    const response = await fetch("/api/agent/wizard/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: testMessage }),
    });
    if (!response.ok) {
      throw new Error(await responseError(response, "No se pudo ejecutar la prueba"));
    }
    const body = await response.json();
    setTestResponse(body.response ?? "El agente no produjo una respuesta visible.");
    setTested(true);
  }

  return (
    <div className="min-h-full bg-background">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-background px-4 py-3 sm:px-6">
        <div>
          <p className="text-xs font-medium text-primary">Configuración guiada</p>
          <h2 className="text-lg font-bold">Configurar agente</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" /> Cerrar
        </Button>
      </header>

      <div className="border-b bg-card px-4 py-3 sm:px-6">
        <ol className="flex gap-2 overflow-x-auto pb-1" aria-label="Pasos del wizard">
          {STEPS.map((label, index) => (
            <li key={label}>
              <button
                type="button"
                onClick={() => setStep(index)}
                aria-current={step === index ? "step" : undefined}
                className={`flex min-w-max items-center gap-2 rounded-full border px-3 py-2 text-xs font-medium transition-colors ${
                  step === index
                    ? "border-primary bg-brand-tint text-primary"
                    : "border-border-strong bg-background text-muted-foreground"
                }`}
              >
                {complete[index] ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Circle className="h-3.5 w-3.5" />
                )}
                {index + 1}. {label}
              </button>
            </li>
          ))}
        </ol>
      </div>

      <main className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
        {saved && (
          <p className="rounded-md border border-success-soft bg-success-tint p-3 text-sm text-success-text">
            {saved}
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-md border border-danger-soft bg-danger-tint p-3 text-sm text-danger-text">
            {error}
          </p>
        )}

        {step === 0 && (
          <WizardCard title="Negocio" description="Información esencial que el agente puede usar al responder.">
            <Field label="Nombre del negocio">
              <Input value={business.name} maxLength={120} onChange={(event) => setBusiness({ ...business, name: event.target.value })} />
            </Field>
            <Field label="Descripción breve">
              <Textarea rows={2} value={business.description} maxLength={1000} onChange={(event) => setBusiness({ ...business, description: event.target.value })} />
            </Field>
            <Field label="Qué vende o qué servicio ofrece">
              <Textarea rows={2} value={business.offer} maxLength={1500} onChange={(event) => setBusiness({ ...business, offer: event.target.value })} />
            </Field>
            <Field label="Información esencial">
              <Textarea rows={3} value={business.essentials} maxLength={3000} onChange={(event) => setBusiness({ ...business, essentials: event.target.value })} />
            </Field>
            <Button disabled={busy || !business.name.trim()} onClick={() => void withSave(saveBusiness, "Negocio guardado")}> <Save className="h-4 w-4" /> Guardar negocio</Button>
          </WizardCard>
        )}

        {step === 1 && (
          <WizardCard title="Tono y personalidad" description="Actualiza directamente el perfil actual del agente.">
            <Field label="Nombre del agente"><Input maxLength={60} value={personality.name} onChange={(event) => setPersonality({ ...personality, name: event.target.value })} /></Field>
            <Field label="Tono">
              <div className="flex flex-wrap gap-2">
                {TONES.map((tone) => <Button key={tone} type="button" size="sm" variant={personality.tone === tone ? "default" : "outline"} onClick={() => setPersonality({ ...personality, tone })}>{tone}</Button>)}
              </div>
              <Input className="mt-2" maxLength={500} placeholder="O escribe un tono personalizado" value={personality.tone} onChange={(event) => setPersonality({ ...personality, tone: event.target.value })} />
            </Field>
            <Field label="Instrucciones"><Textarea rows={4} maxLength={8000} value={personality.instructions} onChange={(event) => setPersonality({ ...personality, instructions: event.target.value })} /></Field>
            <Field label="Saludo"><Input maxLength={1000} value={personality.greeting} onChange={(event) => setPersonality({ ...personality, greeting: event.target.value })} /></Field>
            <Button disabled={busy || !personality.name.trim()} onClick={() => void withSave(() => onSaveProfile(personality), "Personalidad guardada")}><Save className="h-4 w-4" /> Guardar personalidad</Button>
          </WizardCard>
        )}

        {step === 2 && (
          <WizardCard title="Servicios y precios" description="Usa el mismo catálogo que Agenda; los servicios existentes no se duplican.">
            {catalogLoading ? <p className="text-sm text-muted-foreground">Cargando catálogo…</p> : (
              <ul className="space-y-2">{services.map((service) => <li key={service.id} className="flex items-center justify-between rounded-md border p-3 text-sm"><span><strong>{service.name}</strong><br /><span className="text-muted-foreground">{service.durationMinutes} min</span></span><span>{new Intl.NumberFormat("es-MX", { style: "currency", currency: service.currency }).format(service.priceCents / 100)}</span></li>)}</ul>
            )}
            <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
              <Field label="Servicio"><Input maxLength={120} value={serviceForm.name} onChange={(event) => setServiceForm({ ...serviceForm, name: event.target.value })} /></Field>
              <Field label="Precio MXN"><Input type="number" min="0" step="0.01" value={serviceForm.price} onChange={(event) => setServiceForm({ ...serviceForm, price: event.target.value })} /></Field>
              <Field label="Duración (minutos)"><Input type="number" min="5" max="1440" value={serviceForm.duration} onChange={(event) => setServiceForm({ ...serviceForm, duration: event.target.value })} /></Field>
              <Field label="Descripción"><Input maxLength={2000} value={serviceForm.description} onChange={(event) => setServiceForm({ ...serviceForm, description: event.target.value })} /></Field>
            </div>
            <div className="flex flex-wrap gap-2"><Button disabled={busy || !serviceForm.name.trim()} onClick={() => void withSave(addService, "Servicio guardado")}><Save className="h-4 w-4" /> Agregar servicio</Button><Button variant="outline" onClick={() => window.location.assign("/settings/calendar")}>Administrar catálogo completo</Button></div>
          </WizardCard>
        )}

        {step === 3 && (
          <WizardCard title="Horarios y políticas" description="Se guarda como conocimiento manual disponible para el agente.">
            <Field label="Políticas e información operativa"><Textarea rows={10} maxLength={7900} placeholder="Horario de atención, citas, cancelaciones, anticipos, pagos, zona de servicio…" value={policies} onChange={(event) => setPolicies(event.target.value)} /></Field>
            <Button disabled={busy || !policies.trim()} onClick={() => void withSave(() => saveKbBlock(POLICIES_KB_PREFIX, policies), "Políticas guardadas")}><Save className="h-4 w-4" /> Guardar políticas</Button>
          </WizardCard>
        )}

        {step === 4 && (
          <div className="space-y-3">
            <div><h3 className="text-lg font-bold">Documentos</h3><p className="text-sm text-muted-foreground">Misma carga, revisión y aprobación de la base documental. Nada se autoaprueba.</p></div>
            {knowledgePanel}
          </div>
        )}

        {step === 5 && (
          <WizardCard title="Escalamiento a humano" description="Actualiza las reglas existentes de handoff; no crea un flujo paralelo.">
            <Field label="Cuándo pasar a una persona"><Textarea rows={8} maxLength={4000} placeholder="Cliente pide asesor, está molesto, negociación especial…" value={escalationRules} onChange={(event) => setEscalationRules(event.target.value)} /></Field>
            <Button disabled={busy || !escalationRules.trim()} onClick={() => void withSave(() => onSaveProfile({ escalationRules }), "Reglas de escalamiento guardadas")}><Save className="h-4 w-4" /> Guardar escalamiento</Button>
          </WizardCard>
        )}

        {step === 6 && (
          <WizardCard title="Agenda" description="Estado calculado desde servicios, profesionales y disponibilidad reales.">
            {catalogLoading ? <p className="text-sm text-muted-foreground">Consultando agenda…</p> : <div className="grid gap-3 sm:grid-cols-3"><Status label="Servicios activos" ok={services.some((service) => service.active)} /><Status label="Profesionales activos" ok={professionals.some((professional) => professional.status === "active")} /><Status label="Disponibilidad" ok={agendaHasHours} /></div>}
            <p className="text-sm text-muted-foreground">{state.agenda ? "Agenda configurada." : "Falta completar una o más partes de la agenda."}</p>
            <Link href="/settings/calendar" className="inline-flex items-center gap-2 text-sm font-semibold text-primary hover:underline">Abrir configuración de agenda <ExternalLink className="h-4 w-4" /></Link>
          </WizardCard>
        )}

        {step === 7 && (
          <WizardCard title="Probar agente" description="Prueba segura con el pipeline real. No envía mensajes por WhatsApp.">
            <Badge variant="secondary">Conversación de prueba</Badge>
            <Field label="Mensaje del cliente"><Textarea rows={4} maxLength={2000} placeholder="Escribe una pregunta para el agente…" value={testMessage} onChange={(event) => setTestMessage(event.target.value)} /></Field>
            <Button disabled={busy || !aiConfigured || !testMessage.trim()} onClick={() => void withSave(runTest, "Prueba completada")}><Play className="h-4 w-4" /> Ejecutar prueba</Button>
            {!aiConfigured && <p className="text-sm text-warning-text">Conecta el proveedor de IA antes de probar.</p>}
            {testResponse && <div className="rounded-md border bg-secondary p-4"><p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Respuesta del agente</p><p className="whitespace-pre-wrap text-sm">{testResponse}</p></div>}
            <Link href="/lab" className="inline-flex items-center gap-2 text-sm font-semibold text-primary hover:underline">Abrir Laboratorio completo <ExternalLink className="h-4 w-4" /></Link>
          </WizardCard>
        )}

        {step === 8 && (
          <WizardCard title="Activar" description="Revisa el estado. Completar pasos no activa el agente automáticamente.">
            <div className="grid gap-2 sm:grid-cols-2"><Status label="Perfil" ok={state.personality} /><Status label="Conocimiento manual" ok={state.business || state.policies || entries.length > 0} /><Status label={`Documentos activos: ${state.activeDocuments}`} ok={state.documents} optional /><Status label="Reglas de handoff" ok={state.handoff} /><Status label="Agenda" ok={state.agenda} optional /><Status label="Prueba del agente" ok={state.tested} optional /></div>
            {!state.criticalReady && <p role="alert" className="text-sm text-danger-text">Falta un nombre válido para el agente.</p>}
            {!aiConfigured && <p role="alert" className="text-sm text-danger-text">La IA no está conectada; no se puede activar.</p>}
            <Button disabled={busy || profile.enabled || !state.criticalReady || !aiConfigured} onClick={() => void withSave(() => onSaveProfile({ enabled: true }), "Agente activado")}><Check className="h-4 w-4" /> {profile.enabled ? "Agente activado" : "Activar agente"}</Button>
          </WizardCard>
        )}

        <div className="flex items-center justify-between border-t pt-4">
          <Button variant="outline" disabled={step === 0} onClick={() => setStep((current) => current - 1)}><ArrowLeft className="h-4 w-4" /> Anterior</Button>
          <span className="text-xs text-muted-foreground">Paso {step + 1} de {STEPS.length}</span>
          <Button disabled={step === STEPS.length - 1} onClick={() => setStep((current) => current + 1)}>Siguiente <ArrowRight className="h-4 w-4" /></Button>
        </div>
      </main>
    </div>
  );
}

function WizardCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent className="space-y-4">{children}</CardContent></Card>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>;
}

function Status({ label, ok, optional = false }: { label: string; ok: boolean; optional?: boolean }) {
  return <div className="flex items-center gap-2 rounded-md border p-3 text-sm">{ok ? <Check className="h-4 w-4 text-success-text" /> : <Circle className="h-4 w-4 text-muted-foreground" />}<span className="flex-1">{label}</span>{optional && !ok && <Badge variant="secondary">Opcional</Badge>}</div>;
}
