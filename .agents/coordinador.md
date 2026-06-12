# Agente Coordinador (Orquestador de Evolución Multi-Agente)

## Descripción
Este agente actúa como el controlador principal de flujo y orquestador del ciclo de vida del procesamiento de un mensaje de WhatsApp. Decide qué sub-agentes llamar, recopila y valida sus respuestas dentro de un contexto de ejecución, y gestiona las notificaciones y persistencia finales.

## Inputs
- `body` (string): Mensaje crudo de WhatsApp.
- `sender` (string): Nombre del remitente.
- `groupName` (string): Nombre del grupo.
- `senderPhone` (string): Teléfono del remitente.

## Herramientas / Sub-Agentes Bajo Control
- **Filtro RegEx** (Pre-Filtro local rápido).
- **Agente Extractor** (`extractor.md`).
- **Agente Geolocalizador** (`geolocator.md`).
- **Motor de Match** (`matcher.ts`).
- **Servicios de Salida**: WhatsApp Notification API, Google Sheets API.

## Outputs (Estructurado)
- `PipelineContext`: Contexto completo de ejecución con todos los estados de procesamiento intermedio y finales, ideal para ser guardado directamente en la base de datos relacional.
