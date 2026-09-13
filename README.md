# Conecta Digital CRM

**CRM de WhatsApp con inteligencia artificial, seguimiento comercial y agenda.**

Conecta Digital CRM es una adaptación de Vocero CRM orientada a negocios que venden y atienden por WhatsApp. Mantiene la arquitectura self-hosted del proyecto original y agrega una identidad propia para evolucionar hacia una solución especializada en automatización comercial.

## Qué incluye

- Bandeja de WhatsApp en tiempo real.
- Contactos y pipeline Kanban.
- Agente de IA configurable con conocimiento del negocio.
- Handoff a humano.
- API para conectar un agente externo.
- Agenda opcional con huecos reales y protección contra citas inventadas.
- Conectores para enlace fijo, Zoom y Google Calendar + Meet.
- Plantillas de WhatsApp.
- Usuarios de equipo.
- Conversiones de anuncios mediante Meta Conversions API.
- Canales opcionales de Instagram y Messenger.
- Laboratorio interno para evaluar el comportamiento del agente antes de hablar con clientes reales.

## Enfoque de Conecta Digital

El objetivo de esta versión es convertirse en un sistema de atención, seguimiento y citas para negocios de servicios, comenzando por salones de belleza y estéticas.

La evolución prevista incluye:

- servicios con duración y precio,
- profesionales y disponibilidad individual,
- agenda por profesional,
- recordatorios de cita,
- reprogramaciones y cancelaciones,
- seguimiento automático de prospectos que preguntaron y no agendaron,
- reactivación de clientas inactivas,
- automatización de solicitud de reseñas,
- métricas de conversaciones, citas y conversiones.

## Arquitectura

- Next.js 15 + React 19
- TypeScript
- PostgreSQL
- Drizzle ORM
- Better Auth
- Tailwind CSS
- WhatsApp Cloud API de Meta
- Adaptador LLM compatible con OpenRouter/OpenAI
- Docker

## Agenda

La agenda se activa con:

```bash
AGENDA=on
```

El motor solo permite reservar horarios que realmente fueron ofrecidos y evita confirmar citas que no se crearon. Los conectores disponibles incluyen enlace fijo, Zoom y Google Calendar + Meet.

## WhatsApp

Conecta Digital consume credenciales de WhatsApp Cloud API de Meta. Cada instancia puede utilizar las credenciales del negocio correspondiente.

Para agencias, la arquitectura original contempla un flujo tipo Tech Provider en el que una plataforma externa realiza Embedded Signup y entrega a la instancia del cliente su WABA ID, Phone Number ID y token.

## Inteligencia artificial

El agente puede configurarse mediante un proveedor compatible con OpenRouter/OpenAI. La lógica crítica del negocio —por ejemplo disponibilidad y creación real de citas— debe permanecer en el backend y no depender de que el modelo invente datos.

Variables principales:

```bash
OPENROUTER_API_TOKEN=sk-or-...
OPENROUTER_MODEL=...
OPENROUTER_JUDGE_MODEL=
OPENROUTER_BASE_URL=https://openrouter.ai/api
```

## Instalación

Requisitos principales:

- Node.js 20+
- PostgreSQL
- Docker para el despliegue recomendado
- Dominio HTTPS para webhooks de Meta
- Número conectado a WhatsApp Cloud API

Desarrollo local:

```bash
pnpm install
pnpm dev
```

Build:

```bash
pnpm build
pnpm start
```

## Estado del proyecto

Actualmente se está realizando el rebranding de la aplicación a **Conecta Digital** y la adaptación funcional hacia un CRM especializado en negocios de belleza.

La base existente ya incluye CRM, conversaciones, IA, agenda y conexiones con Meta; la siguiente fase es verticalizar servicios, profesionales, disponibilidad y automatizaciones específicas del nicho.

## Licencia y atribución

Este fork conserva la licencia **MIT** del proyecto original.

Proyecto original: **Vocero CRM**, creado por Kevin Belier.

La licencia MIT permite usar, modificar y distribuir el software sujeto a conservar los avisos de copyright y licencia correspondientes. Consulta [`LICENSE`](LICENSE) para los términos exactos.
