-- Cuarta tanda de alias (post neighborhoods_seed_poi_2026-10-01{,b,c}.sql): completa variantes de
-- acento que quedaron a medio curar en el seed original KAN-85, y agrega alias cortos (sin el
-- prefijo "Barrio") para los barrios residenciales reales del grupo "Barrios" que hoy no tienen
-- ninguna cobertura más allá de su nombre técnico completo.
--
-- Contexto (ver conversación de verificación pre-beta, 2026-10-02): se encontró que la resolución
-- de zonas (resolveNeighborhoodByText en src/services/zonesService.ts) hace matching de substring
-- literal, case-insensitive pero SIN normalización de acentos ni de puntuación. El seed KAN-85
-- original dejó algunos pares acento/sin-acento incompletos (solo una de las dos formas curada):
--   - 'peron' existía, faltaba 'perón'.
--   - 'las cañas' existía, faltaba 'las canas'.
-- Se completan ambos pares abajo.
--
-- No se incluyen (decisión explícita del usuario, 2026-10-02):
--   - BARRIO_AEROPUERTO: el alias corto 'aeropuerto' ya está tomado por AEROPUERTO_BENJAMIN_MATIENZO
--     (POI, neighborhoods_seed_poi_2026-10-01.sql) — UNIQUE constraint en neighborhood_aliases.alias
--     no permite que un mismo string resuelva a dos zonas distintas. Queda cubierto solo por su
--     nombre técnico completo ("barrio aeropuerto").
--   - BARRIO_ALTO_VERDE_I / BARRIO_ALTO_VERDE_II: 'alto verde' ya está tomado por ZONA_ALTO_VERDE
--     (neighborhoods_seed_poi_2026-10-01c.sql). Son barrios más chicos dentro de esa zona amplia —
--     decisión del usuario: no curar alias propio por ahora, bajo volumen esperado de búsqueda
--     específica por ellos en el beta.
--   - BARRIO_JARDIN, BARRIO_MODELO, BARRIO_POLICIAL: palabras de diccionario de alta frecuencia en
--     descripciones de propiedades sin relación al barrio (ej. "depto con jardín", "unidad modelo",
--     "cerca de la comisaría"/zona "policial" genérica) — alias corto arriesgaría falsos positivos.
--     Decisión del usuario: dejar afuera, quedan cubiertos solo por nombre técnico completo.
--   - BARRIO_PROCREAR_EX_RADIO_NACIONAL: "Procrear" es un programa de vivienda nacional usado para
--     decenas de barrios distintos en todo el país, no es específico de este — mismo riesgo que los
--     tres anteriores, se excluye el alias corto "procrear".
--   - BARRIO_12_DE_JUNIO_UTA, BARRIO_95_VIVIENDAS__LAS_TALITAS: forma corta ambigua (podría referirse
--     a la localidad "Las Talitas" en general, no a este barrio puntual) — queda para curación
--     posterior si se confirma que hace falta.
--
-- Verificado contra la DB real (2026-10-02): ninguno de estos alias colisiona con uno existente.

-- ============================================================
-- 1) Variantes de acento faltantes (completa pares existentes)
-- ============================================================
INSERT INTO public.neighborhood_aliases (neighborhood_id, alias) VALUES
  ((SELECT id FROM public.neighborhoods WHERE id = (SELECT neighborhood_id FROM public.neighborhood_aliases WHERE alias = 'peron')), 'perón'),
  ((SELECT id FROM public.neighborhoods WHERE id = (SELECT neighborhood_id FROM public.neighborhood_aliases WHERE alias = 'las cañas')), 'las canas')
ON CONFLICT (alias) DO NOTHING;

-- ============================================================
-- 2) Alias cortos para barrios reales sin cobertura (nombres propios, bajo riesgo de falso positivo)
-- ============================================================
INSERT INTO public.neighborhood_aliases (neighborhood_id, alias) VALUES
  ((SELECT id FROM public.neighborhoods WHERE name = 'BARRIO_BERNEL'), 'bernel'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'BARRIO_BGH'), 'bgh'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'BARRIO_CASTILLO'), 'castillo'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'BARRIO_ECHEVERRIA'), 'echeverria'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'BARRIO_EL_BOSQUE'), 'el bosque'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'BARRIO_EL_PARQUE'), 'el parque'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'BARRIO_JOCKEY_CLUB'), 'jockey club'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'BARRIO_JOCKEY_CLUB'), 'jockey'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'BARRIO_KENNEDY'), 'kennedy'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'BARRIO_MARTI_COLL'), 'marti coll'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'BARRIO_SAN_JORGE'), 'san jorge'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'BARRIO_SANTILLAN'), 'santillan'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'BARRIO_TARCOS'), 'tarcos'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'BARRIO_DE_PSICOLOGOS'), 'psicologos'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'BARRIO_INGENIO_CONCEPCION'), 'ingenio concepcion'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'BARRIO_16_VIVIENDAS'), '16 viviendas'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'BARRIO_PORTAL_DEL_CERRO'), 'portal del cerro'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'BARRIO_NICOLAS_AVELLANEDA_IV'), 'nicolas avellaneda')
ON CONFLICT (alias) DO NOTHING;
