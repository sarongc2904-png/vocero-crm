# Confirmación de acciones de agenda (pendientes)

Ninguna cita se crea, mueve ni cancela desde la conversación sin una acción
pendiente **ejecutable** y una confirmación explícita del cliente en ese turno,
aunque el modelo pida `book_slot`, `reschedule_slot` o `cancel_booking`. El
modelo solo deja la pendiente y pregunta; ejecutar es exclusivo del bloque del
pipeline que consume la pendiente (`src/server/ai/pipeline.ts`).

## Cuándo una pendiente es ejecutable

`consumePendingAction` (`src/server/agenda/pending-actions.ts`) la borra con un
solo `DELETE … RETURNING` cuyo `WHERE` exige, todo a la vez:

1. **Vigente**: `expires_at > ahora` (30 minutos).
2. **Ligada a su pregunta**: el `id` de la pendiente es el id del mensaje
   saliente que pidió la confirmación, y ningún otro mensaje saliente de la
   conversación (del agente o de un operador) es posterior **ni simultáneo**.
   Si después escribió un operador o el agente habló de otra cosa, el "sí" ya
   no contesta a esa pregunta.
3. **El "sí" llegó después de la pregunta**: el pipeline pasa el id del
   mensaje entrante que procesa, y ese entrante tiene que ser de la
   conversación y tener `created_at` estrictamente posterior al de la
   pregunta. Un "sí" guardado antes (el cliente contestó a un operador
   mientras el turno que creaba la pregunta seguía en curso, o un eco tardío
   dejó un "sí" anterior como último entrante) no la ejecuta. Un "sí" del
   mismo instante tampoco.
4. **Misma sesión**: IA encendida, sin handoff activo y sin reinicio de sesión
   (`ai_context_reset_at`) desde que se creó. Pausar o reanudar la IA desde la
   bandeja (`updateConversation` con `aiEnabled`) borra la pendiente, igual
   que reactivar tras un handoff.
5. **Con su cita**: cancelar y reprogramar guardan el `booking_id` exacto. Al
   confirmar se actúa sobre ESA cita, y solo si sigue activa y es del mismo
   contacto y negocio.

Además, cualquier mensaje entrante que no sea una confirmación explícita la
descarta: cambio de tema, otra hora, negativa, duda ("sí, ¿y cuánto
cuesta?", que se responde normalmente) y mensajes sin texto (audio, imagen,
sticker). Una pendiente nueva reemplaza a la anterior.

## Qué confirma

- **Agendar**: cualquier confirmación limpia ("sí", "ok", "dale", "perfecto",
  "está bien", 👍). El emoji 👍 cuenta como "ok": en WhatsApp es la forma
  habitual de aceptar una propuesta y una reserva no destruye nada.
- **Cancelar y reprogramar**: solo un "sí" claro ("sí", "si", "confirmo",
  "de acuerdo", "sí, gracias", "sí, cancélala", "claro que sí"). "claro" a
  secas, "claro, gracias", "ok", "ok gracias", "gracias", "dale", "perfecto",
  "está bien" y 👍 no bastan: descartan la pendiente. "claro que no" nunca
  confirma.

## Si ejecutar falla

La pendiente ya se consumió, así que el cliente siempre recibe una respuesta
determinista (en tú o usted según el perfil) y el error nunca vuelve al job:
un reintento haría que el modelo improvisara sobre un "sí" ya consumido.

- **Reprogramar a un horario ocupado o que ya no se ofrece** (`slot_taken`,
  `slot_not_offered`): se ofrecen alternativas; al elegir otra se vuelve a
  preguntar antes de mover.
- **La cita ya no está activa**: "No encontré una cita activa para …".
- **Error inesperado** (base de datos, proveedor): "No pude agendar/mover/
  cancelar tu cita automáticamente. Un asesor continuará contigo." y handoff
  (`handoff_reason = 'error'`).
- **Falla el envío de la respuesta**: handoff. Si la acción sí se ejecutó, no
  se dice que falló; un asesor confirma.

## Varias citas

Con más de una cita activa y un mensaje que no identifica cuál (día, fecha u
hora), el agente lista las citas y pregunta. Mientras tanto la pendiente queda
sin cita y no es ejecutable. La pregunta de confirmación nombra la cita (fecha
y hora) y, al reprogramar, la hora actual y la nueva. Elegir una hora mientras
se habla de cambiar una cita deja una pendiente `reschedule` sobre la cita
existente: al confirmar se mueve, no se crea otra. Vale igual si la hora la
elige la selección determinista o el `book_slot` del modelo. "Se habla de
cambiar" = algún mensaje del cliente en la sesión posterior a la última acción
de agenda completada lo pide, o la última pregunta del agente era de mover la
cita.

"Cancela la del domingo" (sin la palabra "cita") también es una orden de
cancelar: el artículo seguido de "del/de/que/próxima" señala una cita.

## Pruebas

- `tests/unit/booking-confirmation-postgres.test.ts`: pipeline real contra un
  **Postgres real**. Solo corre con `VOCERO_TEST_PG_URL` apuntando a una base
  descartable con las migraciones aplicadas:

  ```bash
  VOCERO_TEST_PG_URL=postgres://usuario@127.0.0.1:55432/base pnpm vitest run tests/unit/booking-confirmation-postgres.test.ts
  ```

- El resto (`booking-confirmation-guard`, `booking-confirmation-strict`,
  `pending-action-binding`, `pending-action-consume`, `pending-action-order`,
  `cancel-intent`, `agent-cancellation-e2e`) corre en `pnpm test` sin base de
  datos.

## Deuda técnica

- **`pending_agenda_action.id` guarda el id del mensaje de la pregunta.** Se
  hizo así para no cambiar el esquema. Lo correcto es una columna
  `question_message_id` (y un `id` propio de fila) en una **migración futura,
  que requiere autorización**. Hoy nada más usa esa columna como id de fila:
  las filas se buscan siempre por conversación.

## Pendientes conocidos (no resueltos aquí)

- **API del bot sin confirmación del cliente.** `POST /api/bot/bookings` crea
  y `PATCH /api/bot/bookings` mueve citas directamente (y `PATCH` mueve la
  próxima cita activa, no una elegida). Quien conduce la conversación por esa
  API es responsable de confirmar con el cliente.
- **Eco muy tardío de un mensaje del operador.** Si un operador escribe desde
  el teléfono y Meta entrega el eco DESPUÉS de que ya se consumió la pendiente
  con el "sí" del cliente, ese mensaje no pudo invalidarla. Si el eco llega
  antes del consumo, sí la invalida (es un saliente posterior a la pregunta).
  Cerrarlo del todo exigiría ordenar por la hora de WhatsApp
  (`wa_timestamp`), no por la de ingesta.
- **Fila de mensaje borrada a mano.** La app no tiene ninguna ruta que borre
  mensajes, pero si alguien borra en la base la fila del saliente posterior a
  la pregunta, la pregunta vuelve a ser la última y un "sí" posterior la
  ejecutaría.
- **Proceso que muere tras consumir.** Si el proceso se cae justo después de
  consumir la pendiente y antes de responder, el reintento del job trata el
  "sí" sin pendiente (respuesta normal del modelo). Los errores capturables ya
  no llegan al job.
- **El CI no ejecuta la suite con Postgres.** El job `postgres-e2e` de
  `.github/workflows/ci.yml` corre `pnpm test:release:postgres`, no Vitest con
  `VOCERO_TEST_PG_URL`. Incluirla requiere cambiar `ci.yml` (no se hizo).
- **Dos profesionales a la misma hora.** Hoy ningún escritor de ofertas mezcla
  profesionales en una misma oferta (la API del bot y `refreshOffer` usan uno
  solo; `offerSlots` del agente, ninguno). Si llegara a pasar, el agente
  pregunta con quién nombrando a cada profesional y la pendiente guarda el
  elegido; las listas de horarios del agente todavía no muestran el nombre del
  profesional (propuesta para un PR aparte).
