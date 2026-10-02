# Agente Coordinador (Orquestador del Pipeline de Matching)

## Descripción
No es un único archivo `coordinator.ts` sino la combinación de `src/controllers/searchController.ts#createSearch`
y `src/services/searchSegmentProcessor.ts`: el flujo que orquesta el ciclo de vida de una búsqueda
en texto libre publicada por un tenant desde el dashboard web (`POST /api/search`). Decide qué
sub-agentes de IA llamar, valida sus respuestas, persiste `active_searches`/`match_queue` y dispara
las notificaciones finales.

**Actualización (pivot a matching 100% web, KAN-64):** este agente ya NO procesa mensajes de
WhatsApp — el bot de WhatsApp (Baileys), `whatsapp_sessions` y el código asociado
(`services/whatsapp.ts`, `supabaseAuth.ts`, `sessionCleanup.ts`, `notifier.ts`) fueron eliminados
del repo. El input es el texto que el propio tenant tipea en el formulario de búsqueda del
dashboard. Ver `.agent/CONTEXT.md` sección 2/5 para el detalle y fecha del pivot.

## Inputs
- `text` (string, body de `POST /api/search`): texto libre de la búsqueda, tal como lo escribe el
  tenant en el dashboard. Puede describir 2+ pedidos independientes en un mismo texto.
- `tenantId` / `req.supabaseClient`: identidad y cliente Supabase scoped al tenant autenticado
  (`tenantAuthMiddleware`), resueltos antes de llegar al controller.

## Herramientas / Sub-Agentes Bajo Control
- **Validación de input**: `validateFreeSearchText` (`src/utils/searchValidation.ts`) — longitud y
  contenido antes de gastar ninguna llamada a IA.
- **Cuota del plan**: `getTenantPlanLimits` / `countTenantSearchesThisMonth` (`services/planLimits.ts`)
  — corta antes de segmentar si ya no queda cuota mensual de búsquedas.
- **Agente 0 (Segmentador)**: `segmentSearchRequests` (`services/ai.ts`) — divide el texto en N
  pedidos independientes. Fail-soft: nunca lanza, degrada a `[freeText]` completo ante cualquier
  fallo.
- **Agente Extractor** (`extractor.md`) — por cada segmento.
- **Agente Geolocalizador** (`geolocator.md`) — por cada segmento.
- **Agente Validador** (`validador.md`) — por cada propiedad candidata.
- **Motor de Match**: `findCrossTenantMatches` (`services/blindMatching.ts`) — cruza cada búsqueda
  contra la cartera de propiedades de **otros** tenants (nunca la propia), aplicando el filtro duro
  de zona (`ZoneStatus`) y el resto de criterios estructurados.
- **Servicios de Salida**: Web Push (`services/webPush.ts`, VAPID) al dashboard del tenant, y el
  WebSocket propio (`realtimeHub.ts`) para actualizaciones en vivo. No hay WhatsApp Notification API
  ni Google Sheets — ambos fueron parte de la arquitectura pre-KAN-64.

## Outputs (Estructurado)
- Una fila en `active_searches` por segmento (`criteria` guarda el `ExtractedRealEstateRequest` tal
  cual lo devuelve `extractFromTextInput`).
- Filas en `match_queue` por cada propiedad candidata validada, con `score`/`validation_score`/
  `is_valid`/`reasoning`/`user_review_status`.
- Respuesta HTTP con el resumen de segmentos procesados (`SearchSegmentResult[]`, ver
  `searchSegmentProcessor.ts`) y notificación push/WS a los tenants dueños de las propiedades
  matcheadas.
