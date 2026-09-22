# Roadmap producto — CRM de WhatsApp con IA

Este roadmap convierte la investigación competitiva en trabajo de producto. La prioridad no es acumular módulos, sino mejorar confiabilidad, seguimiento y velocidad de operación.

## P0 — Confiabilidad operativa

- [x] Bandeja como pantalla inicial.
- [x] Handoff IA → humano idempotente: una sola transición y una sola despedida.
- [x] Reactivar IA desde la conversación.
- [x] Laboratorio por tenant para probar escenarios antes de activar.
- [ ] Observabilidad de mensajes fallidos y alertas operativas.
- [ ] Prueba E2E de handoff con mensajes consecutivos reales.

## P1 — Sistema de ventas

- [x] Próxima acción por lead: tipo, fecha/hora y nota.
- [x] Métrica de leads sin próxima acción.
- [x] Métrica de próximas acciones vencidas.
- [x] Alerta de conversaciones sin respuesta >30 min y seguimientos vencidos en dashboard.
- [ ] Notificaciones automáticas de leads sin respuesta / sin seguimiento.
- [ ] Seguimiento automático configurable por tenant.
- [ ] Clasificación estructurada de intención (información, precio, compra, cita, queja, humano).
- [ ] Historial auditable de decisiones de IA por conversación.

## P1 — Onboarding

- [ ] Wizard de 5–7 pasos: negocio → WhatsApp → oferta/KB → horario → agenda → prueba → activación.
- [ ] Ocultar complejidad de Meta/API al usuario final cuando Embedded Signup esté disponible.
- [ ] Checklist de readiness con una sola acción siguiente.

## P1 — Dashboard comercial

- [x] Conversaciones, pipeline, montos, citas y fuentes.
- [x] Leads sin próxima acción y acciones vencidas.
- [ ] Leads calificados con contrato formal.
- [ ] Tiempo medio de respuesta IA vs humano.
- [ ] Conversión lead → cita → ganado por periodo.
- [ ] Ingresos atribuidos por fuente/campaña.

## P2 — Escala

- [ ] Analítica histórica por periodos.
- [ ] Omnicanal maduro sin degradar WhatsApp.
- [ ] Campañas/plantillas con control de costos.
- [ ] Medidor de consumo/costo de WhatsApp por tenant.
- [ ] Reglas avanzadas y automatizaciones reutilizables.

## Criterio de producto

Cada función debe responder al menos una de estas preguntas:

1. ¿Evita perder una conversación o un lead?
2. ¿Reduce trabajo manual del negocio?
3. ¿Ayuda a decidir qué hacer ahora?
4. ¿Demuestra impacto comercial?

Si no mejora una de esas cuatro, no es prioridad.
