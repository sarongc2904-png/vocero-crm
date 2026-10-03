import { z } from "zod";

/**
 * Acción tipada del agente: exactamente UNA por turno (FR-021).
 * El servidor valida cada acción contra sus allowlists; lo que no valida se
 * degrada, nunca se ejecuta a ciegas.
 */
const baseActions = [
  z.object({ action: z.literal("none") }),
  z.object({ action: z.literal("reply"), text: z.string().min(1) }),
  z.object({
    action: z.literal("update_lead"),
    note: z.string().min(1),
    reply: z.string().optional(),
  }),
  z.object({
    action: z.literal("move_stage"),
    stage: z.string().min(1),
    reply: z.string().optional(),
  }),
  z.object({
    action: z.literal("handoff"),
    reason: z.string().optional(),
    farewell: z.string().optional(),
  }),
] as const;

/**
 * Contrato aceptado desde el proveedor para conversaciones reales.
 *
 * `none` sigue existiendo como estado interno fail-closed (por ejemplo al
 * degradar una acción no autorizada), pero el modelo no puede elegir silencio
 * como resultado exitoso. Las mutaciones internas también deben traer el
 * texto que recibirá el cliente en el mismo turno.
 */
const modelReplyActions = [
  z.object({ action: z.literal("reply"), text: z.string().min(1) }),
  z.object({
    action: z.literal("update_lead"),
    note: z.string().min(1),
    reply: z.string().min(1),
  }),
  z.object({
    action: z.literal("move_stage"),
    stage: z.string().min(1),
    reply: z.string().min(1),
  }),
] as const;

const modelBaseActions = [
  ...modelReplyActions,
  z.object({
    action: z.literal("handoff"),
    reason: z.string().optional(),
    farewell: z.string().optional(),
  }),
] as const;

/**
 * Acciones de agenda.
 *
 * El campo `day` se acepta únicamente por compatibilidad con modelos/prompts
 * antiguos, pero se SANITIZA a undefined: jamás puede convertirse en fuente de
 * verdad. La fecha real se resuelve en backend con `resolveScheduleScope` /
 * `resolveScheduleIntent` a partir del mensaje del cliente.
 *
 * `reply` es solo introducción opcional, nunca la lista de horarios.
 * `book_slot.startUtc` y `reschedule_slot.startUtc` deben coincidir exactamente
 * con un horario ofrecido previamente por el sistema. El motor de agenda lo
 * valida antes de crear o mover una cita.
 */
const agendaActions = [
  z.object({
    action: z.literal("offer_slots"),
    day: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .transform(() => undefined),
    reply: z.string().optional(),
  }),
  z.object({
    action: z.literal("book_slot"),
    startUtc: z.string().min(1),
    reply: z.string().optional(),
  }),
  z.object({
    action: z.literal("reschedule_slot"),
    startUtc: z.string().min(1),
    reply: z.string().optional(),
  }),
  z.object({ action: z.literal("cancel_booking") }),
] as const;

export const AgentAction = z.discriminatedUnion("action", [
  ...baseActions,
  ...agendaActions,
]);

/**
 * `allowHandoff: false` excluye `handoff` del contrato: se usa en el reintento
 * cuando el backend ya rechazó el handoff del turno, para que el modelo no
 * pueda volver a proponerlo.
 */
export function agentActionSchema(
  agenda: boolean,
  options: { allowHandoff?: boolean } = {}
) {
  if (options.allowHandoff === false) {
    return agenda
      ? z.discriminatedUnion("action", [...modelReplyActions, ...agendaActions])
      : z.discriminatedUnion("action", [...modelReplyActions]);
  }
  return agenda
    ? z.discriminatedUnion("action", [...modelBaseActions, ...agendaActions])
    : z.discriminatedUnion("action", [...modelBaseActions]);
}

/**
 * Tipo de trabajo interno del pipeline: usamos el INPUT del schema porque
 * `offer_slots.day` todavía puede existir en asignaciones internas/legacy.
 * El parseo runtime sigue transformándolo a `undefined`, así que el modelo
 * nunca recupera autoridad sobre la fecha real.
 */
export type AgentActionType = z.input<typeof AgentAction>;

export function resolveStage(
  requested: string,
  stages: { id: string; name: string }[]
): { id: string; name: string } | null {
  const exact = stages.find((s) => s.name === requested.trim());
  if (exact) return exact;
  const lower = requested.trim().toLowerCase();
  return stages.find((s) => s.name.toLowerCase() === lower) ?? null;
}

export function degradeAction(action: AgentActionType): AgentActionType {
  if (action.action === "cancel_booking") return { action: "none" };
  if (
    action.action === "move_stage" ||
    action.action === "offer_slots" ||
    action.action === "book_slot" ||
    action.action === "reschedule_slot"
  ) {
    return action.reply
      ? { action: "reply", text: action.reply }
      : { action: "none" };
  }
  return action;
}
