-- Segunda tanda de puntos de interés (pedido explícito del usuario sobre SMT/Yerba Buena/Tafí
-- Viejo: casa histórica, catedral, parques, facultades UNT, hospitales, puntos de Yerba Buena y
-- Tafí Viejo), mismo criterio que neighborhoods_seed_poi_2026-10-01.sql: círculo de 400m
-- (ST_Buffer sobre geography) alrededor de la coordenada verificada en
-- nominatim.openstreetmap.org / Overpass (2026-10-01).
--
-- DEPENDE de neighborhoods_seed_poi_2026-10-01.sql (debe correr DESPUÉS): el alias de "catedral"
-- más abajo referencia PLAZA_INDEPENDENCIA, creado en ese archivo.
--
-- IMPORTANTE — dos grupos distintos en este archivo:
--   1) Puntos NUEVOS con coordenada verificada con confianza alta (bloque principal).
--   2) Alias para zonas que YA EXISTEN en el seed KAN-85 pero cuyo `name` normalizado
--      (KAN-337) no cubre la forma corta en que un agente los escribiría (ej. "ZONA_PARQUE_9_DE_JULIO"
--      normaliza a "zona parque 9 de julio", que NO es substring de "parque 9 de julio" escrito por
--      un agente — ver resolveNeighborhoodByText: matchea si el TEXTO contiene el keyword, no al
--      revés). Sin estos alias, "busco cerca del parque 9 de julio" seguiría sin resolver pese a
--      que la zona ya está cargada.
--
-- Quedaron afuera de este archivo (no encontrados con confianza en OSM/Nominatim — devolvieron
-- SIN RESULTADO o resultados ambiguos/alejados de la ubicación esperada). Antes de cargarlos a
-- mano conviene confirmar una dirección o coordenada:
--   - Catedral (Basílica) de Tucumán -> por ahora alias a PLAZA_INDEPENDENCIA más abajo (está a
--     metros, en la misma manzana), pero si quieren el punto exacto hay que geocodificarlo aparte.
--   - Peatonal (24 de Septiembre) -> es una calle larga, no un punto; si la quieren como zona
--     habría que decidir un centro arbitrario o modelarla como polígono angosto.
--   - Facultad de Educación Física UNT -> el único resultado de OSM es el Instituto Sup. del
--     Profesorado de Ed. Física Norte Argentino (Barrio Sur) — puede no ser la sede correcta,
--     verificar antes de usar.
--   - Quinta Agronómica (Facultad de Agronomía y Zootecnia) -> OSM la ubica en
--     -26.8396008,-65.2735982, lejos de donde se la ubica habitualmente (zona Av. Roca) — verificar.
--   - Yerba Buena: Shopping Viejo, Rotonda Pie del Cerro, Open Plaza/"El Open", La Hoya -> sin
--     resultado en Nominatim/Overpass.
--   - Tafí Viejo: Hostería Atahualpa Yupanqui -> sin resultado confiable (solo apareció una calle
--     "Atahualpa Yupanqui" en zona Yerba Buena, no en Tafí Viejo, probablemente no es el mismo lugar).
--   - Tafí Viejo: Avenida Constitución -> el único resultado de OSM queda a ~2.5km del centro de
--     Tafí Viejo; puede ser una localidad "Constitución" distinta a la avenida buscada, verificar.

-- ============================================================
-- 1) Puntos nuevos con coordenada verificada
-- ============================================================
INSERT INTO public.neighborhoods (name, group_id, boundary) VALUES
  -- San Miguel de Tucumán
  ('CASA_HISTORICA', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2043239, -26.8330118), 4326)::geography, 400)::geometry),
  ('PARQUE_AVELLANEDA', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2241052, -26.8261620), 4326)::geography, 400)::geometry),
  ('PARQUE_GUILLERMINA', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2604471, -26.8251645), 4326)::geography, 400)::geometry),
  ('PLAZA_SAN_MARTIN', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2106755, -26.8390530), 4326)::geography, 400)::geometry),
  ('MERCADO_DEL_NORTE', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2074155, -26.8272933), 4326)::geography, 400)::geometry),
  ('EL_BAJO', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.1974942, -26.8320425), 4326)::geography, 400)::geometry),
  ('FACULTAD_DE_ARTES', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2098708, -26.8406333), 4326)::geography, 400)::geometry),
  ('FACULTAD_DE_EDUCACION_FISICA', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'), -- confianza media, ver nota
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2103599, -26.8334656), 4326)::geography, 400)::geometry),
  ('FACULTAD_DE_FILOSOFIA_Y_LETRAS', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.1861408, -26.8336902), 4326)::geography, 400)::geometry),
  ('QUINTA_AGRONOMICA', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'), -- confianza media, ver nota
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2735982, -26.8396008), 4326)::geography, 400)::geometry),
  ('HOSPITAL_PADILLA', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2151329, -26.8364787), 4326)::geography, 400)::geometry),
  ('CENTRO_DE_SALUD', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.1954866, -26.8220750), 4326)::geography, 400)::geometry),
  ('HOSPITAL_DEL_NINO', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2110994, -26.8408209), 4326)::geography, 400)::geometry),
  ('MATERNIDAD', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2210512, -26.8270567), 4326)::geography, 400)::geometry),

  -- Yerba Buena
  ('PARQUE_PERCY_HILL', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2832221, -26.8097034), 4326)::geography, 400)::geometry),
  ('UNSTA', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2997205, -26.7985473), 4326)::geography, 400)::geometry),

  -- Tafí Viejo
  ('AV_ALEM_TAFI_VIEJO', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2612165, -26.7299239), 4326)::geography, 400)::geometry),
  ('PLAZA_MITRE_TAFI_VIEJO', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2592663, -26.7343063), 4326)::geography, 400)::geometry),
  ('AV_CONSTITUCION_TAFI_VIEJO', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'), -- confianza media, ver nota
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2276583, -26.7466998), 4326)::geography, 400)::geometry),
  ('MERCADO_MUNICIPAL_TAFI_VIEJO', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2578340, -26.7320874), 4326)::geography, 400)::geometry),
  ('TALLERES_FERROVIARIOS_TAFI_VIEJO', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2538887, -26.7369230), 4326)::geography, 400)::geometry)
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- 2) Alias para formas cortas / zonas ya existentes
-- ============================================================
INSERT INTO public.neighborhood_aliases (neighborhood_id, alias) VALUES
  -- Plaza San Martín y el monumento que ya habíamos cargado quedan a ~10m uno del otro: mismo punto.
  ((SELECT id FROM public.neighborhoods WHERE name = 'PLAZA_SAN_MARTIN'), 'plaza san martin'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'FACULTAD_DE_EDUCACION_FISICA'), 'educacion fisica'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'QUINTA_AGRONOMICA'), 'quinta agronomica'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'QUINTA_AGRONOMICA'), 'facultad de agronomia'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'CENTRO_DE_SALUD'), 'centro de salud'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'HOSPITAL_DEL_NINO'), 'hospital del nino'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'UNSTA'), 'unsta'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'UNSTA'), 'campus santa rosa'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'AV_ALEM_TAFI_VIEJO'), 'avenida alem'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'AV_ALEM_TAFI_VIEJO'), 'av alem'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'PLAZA_MITRE_TAFI_VIEJO'), 'plaza mitre'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'AV_CONSTITUCION_TAFI_VIEJO'), 'avenida constitucion'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'AV_CONSTITUCION_TAFI_VIEJO'), 'av constitucion'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'MERCADO_MUNICIPAL_TAFI_VIEJO'), 'mercado municipal'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'TALLERES_FERROVIARIOS_TAFI_VIEJO'), 'talleres ferroviarios'),

  -- "catedral" no tiene coordenada propia verificada: la basílica está en la misma manzana que
  -- Plaza Independencia, así que por ahora resuelve ahí hasta que carguemos el punto exacto.
  ((SELECT id FROM public.neighborhoods WHERE name = 'PLAZA_INDEPENDENCIA'), 'catedral'),

  -- Zonas que YA EXISTÍAN en el seed KAN-85 pero sin alias para la forma corta/común:
  ((SELECT id FROM public.neighborhoods WHERE name = 'ZONA_PARQUE_9_DE_JULIO'), 'parque 9 de julio'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'ZONA_PLAZA_VIEJA'), 'plaza vieja')
ON CONFLICT (alias) DO NOTHING;
