import { Annotation } from "@langchain/langgraph";
import type { AgentActionType } from "@/server/ai/actions";
import type { OfferedSlot } from "@/server/agenda/offers";
import type { PendingAgendaAction } from "@/server/agenda/pending-actions";
import type { CalendarSettings } from "@/server/agenda/settings";
import type { ChatMessage } from "@/lib/ai";

export type ShadowIntent =
  | "handoff"
  | "cancel"
  | "scheduling"
  | "commercial"
  | "general";

export type ShadowConversation = {
  id: string;
  organizationId: string;
  contactId: string;
  isTest: boolean;
  aiEnabled: boolean;
  handoffAt: Date | null;
  lastInboundAt: Date | null;
};

export type ShadowAgentProfile = {
  id: string;
  organizationId: string;
  enabled: boolean;
  name: string;
  tone: string | null;
  instructions: string | null;
  escalationRules: string | null;
  greeting: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ShadowKbEntry = {
  id: string;
  organizationId: string;
  kind: "qa" | "block";
  question: string | null;
  answer: string | null;
  content: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ShadowContext = {
  now: Date;
  conversation: ShadowConversation;
  profile: ShadowAgentProfile | null;
  history: ChatMessage[];
  lastInboundText: string | null;
  lastOutboundText: string | null;
  lastOutboundAt: Date | null;
  kb: ShadowKbEntry[];
  stages: { id: string; name: string }[];
  settings: CalendarSettings | null;
  offers: OfferedSlot[];
  pendingAction: PendingAgendaAction | null;
};

export type ShadowDecision = {
  conversationId: string;
  organizationId: string | null;
  intent: ShadowIntent | null;
  proposedAction: unknown;
  validatedAction: AgentActionType | null;
  wouldExecute: string | null;
  wouldReply: string | null;
  blocked: boolean;
  reason: string | null;
  trace: string[];
};

export const ShadowAgentState = Annotation.Root({
  conversationId: Annotation<string>,
  expectedOrganizationId: Annotation<string>,
  organizationId: Annotation<string | null>,
  inboundText: Annotation<string>,
  isTest: Annotation<boolean>,
  aiEnabled: Annotation<boolean>,
  commercialAccess: Annotation<boolean>,
  agendaEnabled: Annotation<boolean>,
  hasHandoff: Annotation<boolean>,
  agentProfileFound: Annotation<boolean>,
  agentProfileEnabled: Annotation<boolean>,
  whatsappWindowOpen: Annotation<boolean>,
  intent: Annotation<ShadowIntent | null>,
  proposedAction: Annotation<unknown>,
  validatedAction: Annotation<AgentActionType | null>,
  reply: Annotation<string | null>,
  stop: Annotation<boolean>,
  error: Annotation<string | null>,
  blockedReason: Annotation<string | null>,
  shadowDecision: Annotation<ShadowDecision | null>,
  context: Annotation<ShadowContext | null>,
  pendingActionConfirmed: Annotation<boolean>,
  actionSource: Annotation<"model" | "deterministic" | "pending" | null>,
  trace: Annotation<string[], string[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
});

export type ShadowAgentGraphState = typeof ShadowAgentState.State;
export type ShadowAgentGraphUpdate = typeof ShadowAgentState.Update;
