import { customAlphabet } from "nanoid";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const nano = customAlphabet(alphabet, 20);

const prefixes = {
  organization: "org",
  member: "mem",
  contact: "ct",
  conversation: "cv",
  message: "msg",
  lead: "ld",
  stage: "stg",
  leadStageEvent: "lse",
  credentials: "cred",
  agentProfile: "agp",
  kbEntry: "kb",
  kbDocument: "kbd",
  kbDocumentChunk: "kbc",
  template: "tpl",
  testRun: "run",
  testCase: "case",
  testTrace: "trace",
  testEvidence: "evs",
  agentRun: "arun",
  agentActionEvent: "aev",
  agentEvidence: "aed",
  backgroundJob: "job",
  mediaAsset: "ma",
  // 015 — motor de agenda
  calendarSettings: "cal",
  booking: "bk",
  offeredSlot: "ofs",
  service: "svc",
  professional: "pro",
  professionalService: "ps",
  professionalAvailability: "pav",
  professionalBreak: "pbr",
  professionalTimeOff: "pto",
  bookingEvent: "bke",
  zoomCredentials: "zcred",
  googleCredentials: "gcred",
  // 016 — atribución de anuncios
  adAttribution: "att",
  conversionEvent: "cve",
  capiSettings: "capi",
  // Fase 1 — clave del bot API por organización
  botApiKey: "bak",
  entitlement: "ent",
  onboardingProgress: "obp",
  automationRule: "aur",
  scheduledAutomation: "sau",
  labProfile: "lbp",
  // IA-1 / IA-W2 — confirmación pendiente de una acción de agenda
  pendingAgendaAction: "paa",
  // 0037 — cotizaciones
  quote: "qt",
  quoteItem: "qti",
  quoteLink: "qtl",
  // 0038 — intentos de envío por WhatsApp
  quoteSend: "qts",
} as const;

export type IdKind = keyof typeof prefixes;

export function newId(kind: IdKind): string {
  return `${prefixes[kind]}_${nano()}`;
}
