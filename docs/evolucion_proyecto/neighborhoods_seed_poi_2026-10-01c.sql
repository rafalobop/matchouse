-- Tercera tanda: alias para las 5 zonas del grupo "Zonas" (nivel ciudad, alto tráfico de
-- búsqueda) que seguían sin alias tras neighborhoods_seed_poi_2026-10-01.sql/...b.sql. KAN-337 ya
-- resuelve la forma literal "zona centro"/"zona casco viejo" vía normalizeZoneKeyword, pero NO la
-- forma corta real que un agente tipea sin el prefijo "zona" (ver resolveNeighborhoodByText: el
-- match es texto_usuario.includes(keyword), así que un keyword más largo que lo tipeado nunca
-- resuelve). Sin estos alias, "busco en el centro" quedaba sin match pese a que ZONA_CENTRO ya
-- existe desde el seed KAN-85.
--
-- No crea neighborhoods nuevos, solo alias sobre zonas ya existentes. Alcance acotado a las 5
-- zonas de uso más frecuente (Zonas = nivel ciudad); los 26 Barrios y 19 Countries/Barrios
-- Privados sin alias quedan afuera de este seed (menor probabilidad de ser la primera búsqueda de
-- un beta tester, se curan en una iteración posterior si hace falta).
--
-- Verificado contra la DB real (2026-10-02): ninguno de estos alias colisiona con uno existente.

INSERT INTO public.neighborhood_aliases (neighborhood_id, alias) VALUES
  ((SELECT id FROM public.neighborhoods WHERE name = 'ZONA_CENTRO'), 'centro'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'ZONA_CASCO_VIEJO'), 'casco viejo'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'ZONA_ALTO_VERDE'), 'alto verde'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'ZONA_RINCONADA'), 'rinconada'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'ZONA_RINCONADA'), 'la rinconada'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'ZONA_LAS_4_AVENIDAS'), 'las 4 avenidas'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'ZONA_LAS_4_AVENIDAS'), '4 avenidas'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'ZONA_LAS_4_AVENIDAS'), 'las cuatro avenidas'),
  ((SELECT id FROM public.neighborhoods WHERE name = 'ZONA_LAS_4_AVENIDAS'), 'cuatro avenidas')
ON CONFLICT (alias) DO NOTHING;
