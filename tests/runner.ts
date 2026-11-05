// Importar todas las pruebas para que el test runner de Node las ejecute en orden

// BE-20 (EP-07): `zonesService.ts#resolveMultipleNeighborhoodsByText` puede llamar a la API real
// de embeddings de OpenAI como fallback semántico ante una mención sin match (ver
// embeddings.ts). Sin este guard, cualquier test que ejercite ese camino con una mención real sin
// match (hay varios: ai.test.ts, blindMatching.test.ts, zonesService.test.ts,
// searchSegmentProcessor.test.ts) terminaría pegándole a la API real en cada corrida de
// `pnpm test` — mismo tipo de bug que BE-04 ya encontró y corrigió para `llm_calls`. Deshabilitado
// ANTES de importar cualquier archivo de test: los `import` de abajo ejecutan el código de módulo
// de cada test file en orden (TS compila a `require` de CommonJS), así que este guard tiene que
// correr primero. Tests que SÍ quieren ejercitar `embeddings.ts` de verdad (embeddings.test.ts)
// instalan su propio fake puntual con `__setOpenAIEmbeddingsClientForTests` en cada test.
import { __setOpenAIEmbeddingsClientForTests } from '../src/services/embeddings';
__setOpenAIEmbeddingsClientForTests(null);

import './unit-tests';
import './activeSearches.test';
import './addressParser.test';
import './ai.test';
import './blindMatching.test';
import './blindMatchPersistence.test';
import './bodyWhitelist.test';
import './dashboardMetricsRoute.test';
import './dolar.test';
import './embeddings.test';
import './errorHandler.test';
import './errorMessageLeak.test';
import './excel.test';
import './excelHeaderMatcher.test';
import './excelMapping.test';
import './excelParsePool.test';
import './excelParseWorker.test';
import './excelValidation.test';
import './geocoding.test';
import './health.test';
import './idValidation.test';
import './kan303IncomingMatchHighlight.test';
import './licenseRegistry.test';
import './llmCallsRepository.test';
import './licenseValidationRetry.test';
import './localitiesService.test';
import './logger.test';
import './logRedaction.test';
import './matcher.test';
import './notifications.test';
import './nodeEnvCheck.test';
import './notifier-email.test';
import './planLimits.test';
import './profileValidation.test';
import './promptSafety.test';
import './propertyMatchWebhook.test';
import './rateLimit.test';
import './realtimeHub.test';
import './reengagement.test';
import './routes/adminPanel.route.test';
import './routes/auth.route.test';
import './routes/catalog.route.test';
import './routes/internal.route.test';
import './routes/profile.route.test';
import './routes/upload.route.test';
import './routes/matches.route.test';
import './routes/notifications.route.test';
import './routes/properties.route.test';
import './routes/search.route.test';
import './routes/system.route.test';
import './searchController.test';
import './searchExpiration.test';
import './searchSegmentProcessor.test';
import './searchSegmentsParallel.test';
import './searchValidation.test';
import './sentryDataCollection.test';
import './sentryForwarding.test';
import './supabase.test';
import './tenantAuth.test';
import './truncatedProfileDetector.test';
import './uploadController.test';
import './webPush.test';
import './withTimeout.test';
import './zonesService.test';
