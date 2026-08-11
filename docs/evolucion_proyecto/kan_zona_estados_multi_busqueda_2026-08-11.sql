-- KAN-XX (2026-08-11): estado de zona persistente en active_searches + soporte multi-zona OR.
-- Contexto: hasta este ticket, active_searches no guardaba nada del resultado del Agente 2
-- (zoneIntent) — ni el texto de ubicación, ni si se resolvió, ni contra qué neighborhood_id(s).
-- Esto generaba dos gaps:
--   1) "sin zona mencionada" y "zona mencionada pero no resuelta" eran indistinguibles (ambos
--      colapsaban a zona_id='DESCONOCIDO' en memoria, sin persistir), y el matching trataba a
--      ambos como "no filtrar por zona" — un texto que SÍ menciona una zona real pero no
--      resoluble (typo, barrio no cargado en el catálogo) terminaba matcheando propiedades de
--      cualquier zona, lo cual es un falso positivo.
--   2) findMatchingActiveSearchesForProperty (dirección cartera->búsqueda, KAN-79) no tenía forma
--      de recuperar el intento de zona del Agente 2 al evaluar una propiedad nueva, porque nunca
--      se persistía — siempre evaluaba sin zoneIntent.
--
-- Diseño: zone_status como texto + CHECK constraint, mismo patrón que active_searches.status
-- (CHECK (status IN (...))) y blind_matches.user_review_status — NO se usa CREATE TYPE ... AS
-- ENUM porque el proyecto no tiene ningún enum nativo de Postgres hasta la fecha.

ALTER TABLE public.active_searches
  ADD COLUMN zone_status text NOT NULL DEFAULT 'INDEFINIDA'
    CONSTRAINT active_searches_zone_status_check
    CHECK (zone_status IN ('INDEFINIDA', 'DEFINIDA', 'DESCONOCIDA')),
  ADD COLUMN zone_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN zone_names text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN zone_text_original text NOT NULL DEFAULT '';

COMMENT ON COLUMN public.active_searches.zone_status IS
  'INDEFINIDA: el usuario no mencionó ninguna ubicación (no filtra por zona, mismo comportamiento '
  'que el fallback histórico de ZoneMatchingStrategy). DEFINIDA: se resolvió contra neighborhoods/'
  'neighborhood_aliases, zone_ids tiene 1+ UUIDs, se matchea en OR. DESCONOCIDA: el usuario SÍ '
  'mencionó una ubicación pero no se pudo resolver tras 3 reintentos (withRetry) — filtro duro, '
  'la búsqueda no trae ningún match hasta que se cure (ver self-healing en '
  'findMatchingActiveSearchesForProperty).';
COMMENT ON COLUMN public.active_searches.zone_ids IS
  'UUIDs de neighborhoods.id resueltos para esta búsqueda cuando zone_status=DEFINIDA. Array '
  'porque una búsqueda puede tener zonas alternativas OR (ej. "villa lujan o tafi viejo"). '
  'Vacío si zone_status es INDEFINIDA o DESCONOCIDA.';
COMMENT ON COLUMN public.active_searches.zone_names IS
  'neighborhoods.name legibles, mismo orden/cardinalidad que zone_ids — para mostrar en UI sin '
  'resolver el UUID en cada request (mismo criterio que ZoneIntentRequest.zona_nombre, KAN-92).';
COMMENT ON COLUMN public.active_searches.zone_text_original IS
  'Texto de ubicación tal cual lo extrajo el Agente 2 (ZoneIntentRequest.texto_ubicacion_original), '
  'persistido para poder reintentar la resolución más adelante (self-healing en '
  'findMatchingActiveSearchesForProperty) sin volver a llamar al LLM. Vacío si zone_status=INDEFINIDA.';

-- Backfill de filas preexistentes: no tienen forma de recuperar retroactivamente qué dijo el
-- Agente 2 en su momento (no se persistía) — se normalizan explícitamente a DESCONOCIDA en vez de
-- INDEFINIDA. Justificación: INDEFINIDA no filtra por zona (comportamiento más permisivo/riesgoso
-- para introducir en un backfill silencioso); DESCONOCIDA sí filtra (0 matches hasta
-- self-healing), que es la degradación más segura. El self-healing (disparado por la próxima
-- propiedad nueva que entre) resuelve esto naturalmente para las búsquedas 'active' viejas cuyo
-- raw_text sí tenía una zona real, sin requerir backfill manual ni job.
UPDATE public.active_searches
SET zone_status = 'DESCONOCIDA'
WHERE status IN ('active', 'expired');

-- Índice parcial para el prefiltro de findMatchingActiveSearchesForProperty (self-healing),
-- mismo criterio que idx_active_searches_criteria_operation/property_type (KAN-79).
CREATE INDEX IF NOT EXISTS idx_active_searches_zone_status
  ON public.active_searches (zone_status)
  WHERE status = 'active';

-- GIN para el match OR de zone_ids contra property.neighborhood_id, preparado para si en el
-- futuro se empuja el filtro de zona a SQL (hoy ZoneMatchingStrategy sigue siendo in-memory).
CREATE INDEX IF NOT EXISTS idx_active_searches_zone_ids
  ON public.active_searches USING GIN (zone_ids)
  WHERE status = 'active' AND zone_status = 'DEFINIDA';
