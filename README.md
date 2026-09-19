# Conecta Digital CRM

CRM multi-tenant de WhatsApp para estéticas, salones, uñas, faciales,
depilación y spas. Convierte conversaciones en prospectos, citas y seguimiento
comercial sin usar a la IA como fuente de verdad para precios, duración o
disponibilidad.

## Capacidades actuales

- Inbox de WhatsApp con deduplicación, estados de entrega, adjuntos y handoff
  IA/humano.
- Contactos, ficha comercial, pipeline configurable, responsables y equipos.
- Catálogo de servicios por organización, con precio, moneda, duración y
  buffers.
- Profesionales, asignación de servicios, horarios semanales, descansos,
  ausencias y bloqueos estructurados.
- Agenda por profesional. Un slot debe haber sido ofrecido y vuelve a validarse
  antes de reservar; PostgreSQL impide reservas activas traslapadas.
- Creación, reprogramación y cancelación de citas, con historial y sincronización
  opcional con enlace fijo, Zoom o Google Calendar + Meet.
- Agente de IA compatible con OpenRouter/OpenAI y Laboratorio aislado de Meta.
- Jobs durables y automatizaciones en PostgreSQL con leases, `SKIP LOCKED`,
  reintentos, recuperación y estado terminal para trabajos agotados.
- Reglas configurables para follow-up, recordatorios y solicitud de reseña.
  Fuera de la ventana de WhatsApp solo se usa una plantilla aprobada.
- Onboarding guiado para negocio, WhatsApp, servicios, profesionales, horarios,
  calendario, conocimiento, prueba y activación.
- Entitlement centralizado con trial de 3 días y estados `trial`, `active`,
  `past_due`, `suspended` y `cancelled`. La expiración no borra datos.
- Dashboard con métricas tenant-scoped, Meta Conversions API y API protegida
  para un agente externo.

## Arquitectura

- Next.js 15, React 19 y TypeScript.
- PostgreSQL como fuente de verdad de negocio y trabajo asíncrono.
- Drizzle ORM y migraciones forward-only.
- Better Auth, organizaciones, memberships y RBAC granular.
- Adaptador LLM compatible con OpenRouter/OpenAI.
- WhatsApp Cloud API de Meta.
- Proceso Node persistente en Docker; los workers se levantan junto al servidor.

El worker actual requiere un proceso Node persistente. No debe desplegarse como
un timer dentro de una función serverless. Google Calendar es una réplica de
integración; la cita local sigue siendo la fuente de verdad comercial.

## Requisitos

- Node.js 20 o superior (la imagen de producción usa Node 22).
- pnpm.
- PostgreSQL 16 recomendado.
- Docker y Docker Compose para la ruta self-hosted recomendada.
- Dominio HTTPS para webhooks reales de Meta.

## Configuración

Copiar `.env.example` a `.env` y completar los valores requeridos. Los secretos
se configuran en runtime y nunca deben agregarse al repositorio.

Variables base:

```bash
APP_BASE_URL=https://crm.ejemplo.com
DATABASE_URL=postgresql://...
BETTER_AUTH_SECRET=...
ENCRYPTION_KEY=...
META_WEBHOOK_VERIFY_TOKEN=...
```

Funciones opcionales:

```bash
AGENDA=on
OPENROUTER_API_TOKEN=...
OPENROUTER_MODEL=...
META_APP_SECRET=...
CHANNELS=whatsapp,instagram,messenger
ATRIBUCION=on
BOT_API_KEY=...
```

Las credenciales de cada tenant para WhatsApp y conectores de agenda se guardan
cifradas desde Ajustes. Consulta `.env.example` para el contrato completo y
`docs/agenda-conectores.md` para Google Calendar y Zoom.

## Desarrollo y migraciones

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

Cada cambio de esquema debe agregar un archivo SQL nuevo y registrarlo en
`drizzle/meta/_journal.json`. El contenedor ejecuta las migraciones al arrancar;
no modifica migraciones históricas.

Para un PostgreSQL local:

```bash
docker compose -f docker-compose.dev.yml up -d
pnpm db:migrate
```

## Producción self-hosted

```bash
cp .env.example .env
docker compose up -d --build
```

El compose incluye PostgreSQL, la aplicación y Caddy. Conserva dos volúmenes
independientes: `vocero_pg` para datos y `vocero_media` para adjuntos. El
arranque aplica migraciones antes de iniciar Next.js y `/api/health` expone la
salud de base de datos y métricas operativas del worker sin revelar secretos.

## WhatsApp

El webhook valida el token de verificación y, cuando existe `META_APP_SECRET`,
la firma `x-hub-signature-256`. Los IDs de Meta hacen idempotente la recepción.
El mensaje se persiste antes de encolar el turno durable del agente. La ventana
de 24 horas determina si una automatización puede enviar texto libre o requiere
una plantilla aprobada.

La aprobación de Meta, la entrega en un número real y las plantillas dependen de
credenciales e infraestructura externas; deben validarse en el entorno destino.

## Agenda y Google Calendar

La agenda se activa con `AGENDA=on`. Precio, duración, profesional y huecos
provienen del backend. Una confirmación solo se genera después de que exista la
cita local. La exclusión temporal en PostgreSQL evita double booking incluso
entre procesos concurrentes.

La sincronización externa conserva el ID del evento y contempla creación,
actualización y cancelación. Errores del proveedor no convierten una operación
fallida en una confirmación falsa. OAuth y permisos de una cuenta real deben
probarse en el tenant de destino.

## Worker y automatizaciones

`src/instrumentation.ts` inicia los workers únicamente en runtime Node. Los
jobs y automatizaciones se reclaman con lease y `FOR UPDATE SKIP LOCKED`; un
proceso muerto puede recuperarse cuando vence el lease. Los trabajos que agotan
el máximo de intentos quedan fallidos/dead-letter y aparecen en métricas y logs
estructurados.

Recordatorios viejos se cancelan al reprogramar y todos los pendientes se
cancelan al cancelar o marcar no-show. Las solicitudes de reseña solo se crean
para citas completadas y requieren enlace configurado por la organización.

## Onboarding y plan

`/onboarding` muestra el progreso de configuración. El plan comercial canónico
es Conecta Digital, $1,397 MXN al mes, con trial de 3 días; el precio vive en la
tabla de planes y no se repite en componentes. No existe cobro automático ni
Stripe en esta versión: los estados comerciales preparan el dominio sin fingir
una integración de pagos.

## Validación

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

El E2E necesita `.env`, PostgreSQL migrado, aplicación en ejecución y los mocks
de WhatsApp/IA configurados como explica `scripts/e2e-selftest.mjs`. Una suite
unitaria verde no sustituye la validación con Meta, Google o infraestructura de
producción.

## Licencia y atribución

Este fork conserva la licencia MIT del proyecto original, Vocero CRM, creado
por Kevin Belier. Consulta `LICENSE` para los términos exactos.
