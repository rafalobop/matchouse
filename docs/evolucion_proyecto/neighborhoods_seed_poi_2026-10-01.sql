-- Carga de puntos de interés (plazas, aeropuerto, terminal, shoppings, monumentos) detectados
-- como faltantes en `neighborhoods` tras cruzar el seed KAN-85
-- (neighborhoods_seed_kan85_2026-07-30.sql) contra OpenStreetMap/Nominatim para San Miguel de
-- Tucumán, Yerba Buena y Tafí Viejo. Cada punto se carga como un círculo de 400m de radio
-- alrededor de su coordenada real (ST_Buffer sobre geography, no un polígono dibujado a mano
-- como el resto del seed KAN-85).
--
-- El `name` de cada fila sigue la misma convención del seed KAN-85 (mayúsculas, guión bajo) para
-- que KAN-337 (normalización automática de `name` -> "plaza urquiza" en texto libre) resuelva la
-- forma obvia de nombrarlo sin necesitar alias. Se agregan alias solo para las formas cortas que
-- un agente realmente tipearía (ej. "terminal", "el aeropuerto") y que no son un substring natural
-- del `name` normalizado.
--
-- Coordenadas verificadas contra nominatim.openstreetmap.org (2026-10-01).

INSERT INTO public.neighborhoods (name, group_id, boundary) VALUES
  ('PLAZA_INDEPENDENCIA', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2038601, -26.8304896), 4326)::geography, 400)::geometry),
  ('PLAZA_URQUIZA', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2026576, -26.8192595), 4326)::geography, 400)::geometry),
  ('PLAZOLETA_MITRE', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2153800, -26.8160800), 4326)::geography, 400)::geometry),
  ('AEROPUERTO_BENJAMIN_MATIENZO', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.1065354, -26.8381095), 4326)::geography, 400)::geometry),
  ('TERMINAL_DE_OMNIBUS', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.1944165, -26.8345387), 4326)::geography, 400)::geometry),
  ('SHOPPING_PORTAL_TUCUMAN', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2678971, -26.8222179), 4326)::geography, 400)::geometry),
  ('SHOPPING_SOLAR_DEL_CERRO', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2898278, -26.8145368), 4326)::geography, 400)::geometry),
  ('MONUMENTO_SAN_MARTIN', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2106900, -26.8390000), 4326)::geography, 400)::geometry),
  ('CASA_DE_GOBIERNO', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.2050600, -26.8299800), 4326)::geography, 400)::geometry),
  ('MONUMENTO_BICENTENARIO', (SELECT id FROM public.neighborhood_groups WHERE name = 'Otros / Puntos de Interés'),
    ST_Buffer(ST_SetSRID(ST_MakePoint(-65.1830000, -26.7791200), 4326)::geography, 400)::geometry)
ON CONFLICT (name) DO NOTHING;

-- Alias para formas cortas que no son substring del `name` normalizado (KAN-337 ya cubre
-- "plaza urquiza", "casa de gobierno", etc. automáticamente a partir del name técnico).
INSERT INTO public.neighborhood_aliases (neighborhood_id, alias) VALUES
  ((SELECT id FROM public.neighborhoods WHERE name = 'AEROPUERTO_BENJAMIN_MATIENZO'), 'aeropuerto'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'AEROPUERTO_BENJAMIN_MATIENZO'), 'el aeropuerto'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'TERMINAL_DE_OMNIBUS'), 'terminal'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'TERMINAL_DE_OMNIBUS'), 'la terminal'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'TERMINAL_DE_OMNIBUS'), 'terminal de omnibus'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'SHOPPING_PORTAL_TUCUMAN'), 'portal tucuman'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'SHOPPING_PORTAL_TUCUMAN'), 'portal shopping'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'SHOPPING_SOLAR_DEL_CERRO'), 'solar del cerro'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'MONUMENTO_SAN_MARTIN'), 'monumento a san martin'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'MONUMENTO_SAN_MARTIN'), 'monumento al general san martin'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'MONUMENTO_BICENTENARIO'), 'monumento al bicentenario')
ON CONFLICT (alias) DO NOTHING;
