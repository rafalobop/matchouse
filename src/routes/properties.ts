import express from 'express';
import { logger } from '../services/logger';
import { validateBodyWhitelist } from '../utils/bodyWhitelist';
import { tenantAuthMiddleware } from '../middleware/tenantAuth';
import {
  resolvePropertiesZoneInfoBatch,
  resolvePropertyZoneInfo,
  type PropertyForZoneBatch
} from '../services/zonesService';
import { getTenantPlanLimits, countTenantProperties } from '../services/planLimits';
import { requireOwner } from '../utils/agencyOwnership';

// KAN-273: CRUD de propiedades para la tabla interactiva del dashboard (visualización, edición,
// filtros/orden, alta y baja desde la UI, sin depender de un re-upload del Excel). Todas las rutas
// van detrás de tenantAuthMiddleware y usan req.supabaseClient (patrón "Tenant Context" de KAN-63)
// en vez del cliente service-role: los permisos de acceso son RLS (tenant_id = current_agency_
// owner_id(), KAN-306 continuación — antes tenant_id = auth.uid()) más el filtro explícito
// .eq('tenant_id', tenantId) en cada query, mismo criterio que matches.ts/upload.ts. Excepción:
// el DELETE está restringido al dueño real de la agencia (ver el handler más abajo).
//
// Prefijo /api/catalog/properties (no /api/properties): src/adminRoutes.ts ya registra
// `GET /api/properties` (panel admin, cross-tenant, adminAuthMiddleware) y mountAdminRouter(app) se
// monta antes que las rutas de tenant en src/index.ts — un tenant pegándole a /api/properties
// hubiera caído siempre en la ruta admin (401 por no tener sesión de admin), nunca en esta. Se
// agrupa bajo /api/catalog, mismo dominio que ya usa GET /api/catalog (conteo, ver upload.ts).

const OPERATIONS = ['venta', 'alquiler', 'compra'] as const;
const PROPERTY_TYPES = ['departamento', 'casa', 'terreno', 'local', 'oficina', 'otro'] as const;
const CURRENCIES = ['USD', 'ARS'] as const;

const SORTABLE_FIELDS = [
  'address', 'price', 'currency', 'bedrooms', 'operation', 'property_type',
  'maintenance_fees', 'created_at', 'updated_at'
] as const;
type SortableField = typeof SORTABLE_FIELDS[number];

// KAN-305: latitude/longitude salieron de UPDATE_FIELDS — un tenant ya no puede pisar el
// geocoding curado editando la fila (antes viajaban igual que cualquier otro campo editable).
// Siguen aceptándose en CREATE_FIELDS (alta, POST) porque ahí no hay nada "curado" todavía que
// proteger: es la primera coordenada que carga el propio tenant o el resultado del geocoding
// automático del upload. La corrección posterior de una coordenada ya cargada queda exclusivamente
// del lado admin (`PATCH /admin/api/properties/:id/coordinates`, KAN-130) — el tenant solo puede
// pedirla vía el nuevo POST .../request_correction más abajo.
const CREATE_FIELDS = [
  'address', 'floor', 'unit', 'block', 'lot', 'price', 'currency', 'maintenance_fees',
  'bedrooms', 'features', 'contact_info', 'operation', 'property_type', 'latitude', 'longitude'
] as const;
const UPDATE_FIELDS = [
  'address', 'floor', 'unit', 'block', 'lot', 'price', 'currency', 'maintenance_fees',
  'bedrooms', 'features', 'contact_info', 'operation', 'property_type', 'expectedUpdatedAt'
] as const;

const PROPERTY_SELECT = 'id, address, floor, unit, block, lot, price, currency, maintenance_fees, ' +
  'bedrooms, features, contact_info, operation, property_type, sheet_name, latitude, longitude, ' +
  'needs_coordinate_review, zone_id, neighborhoods!properties_zone_id_fkey(id, name, group_id), ' +
  'created_at, updated_at';

interface ValidationResult {
  error?: string;
}

/** Aplana el join embebido `neighborhoods!properties_zone_id_fkey` de `PROPERTY_SELECT` a un
 * campo `zone` limpio — mismo shape que ya devuelve `GET /api/catalog/properties`. */
function toPropertyResponse(row: any) {
  const { neighborhoods, zone_id, ...rest } = row;
  return { ...rest, zone: neighborhoods ? { id: neighborhoods.id, name: neighborhoods.name } : null };
}

/** Igual criterio que `PATCH /admin/api/properties/:id/coordinates` (KAN-130): cuando lat/lng
 * cambian, el `zone_id` cacheado quedó desactualizado — se recalcula acá y solo se persiste si
 * salió de PostGIS (match por punto), no si es una sugerencia por texto. */
async function refreshZoneId(
  supabase: any,
  id: string,
  latitude: number | null,
  longitude: number | null,
  address: string,
  features: string | null | undefined,
  sheetName: string
): Promise<void> {
  if (latitude === null || longitude === null) {
    await supabase.from('properties').update({ zone_id: null }).eq('id', id);
    return;
  }
  const zoneInfo = await resolvePropertyZoneInfo({
    latitude,
    longitude,
    address,
    features: features ?? undefined,
    sheet_name: sheetName
  });
  await supabase
    .from('properties')
    .update({ zone_id: zoneInfo.source === 'point' ? zoneInfo.zone!.id : null })
    .eq('id', id);
}

// Validación compartida por POST (todos los campos requeridos) y PATCH (solo los presentes).
function validateFields(body: any, requireAll: boolean): ValidationResult {
  if (requireAll || body.address !== undefined) {
    if (typeof body.address !== 'string' || body.address.trim().length === 0) {
      return { error: 'El campo "address" es requerido y debe ser un texto no vacío.' };
    }
  }
  if (requireAll || body.price !== undefined) {
    if (typeof body.price !== 'number' || !Number.isFinite(body.price) || body.price < 0) {
      return { error: 'El campo "price" es requerido y debe ser un número mayor o igual a 0.' };
    }
  }
  if (requireAll || body.currency !== undefined) {
    if (!CURRENCIES.includes(body.currency)) {
      return { error: `El campo "currency" debe ser uno de: ${CURRENCIES.join(', ')}.` };
    }
  }
  if (requireAll || body.operation !== undefined) {
    if (!OPERATIONS.includes(body.operation)) {
      return { error: `El campo "operation" debe ser uno de: ${OPERATIONS.join(', ')}.` };
    }
  }
  if (requireAll || body.property_type !== undefined) {
    if (!PROPERTY_TYPES.includes(body.property_type)) {
      return { error: `El campo "property_type" debe ser uno de: ${PROPERTY_TYPES.join(', ')}.` };
    }
  }
  if (body.bedrooms !== undefined) {
    if (typeof body.bedrooms !== 'number' || !Number.isInteger(body.bedrooms) || body.bedrooms < 0) {
      return { error: 'El campo "bedrooms" debe ser un número entero mayor o igual a 0.' };
    }
  }
  if (body.maintenance_fees !== undefined) {
    if (typeof body.maintenance_fees !== 'number' || !Number.isFinite(body.maintenance_fees) || body.maintenance_fees < 0) {
      return { error: 'El campo "maintenance_fees" debe ser un número mayor o igual a 0.' };
    }
  }
  for (const field of ['floor', 'unit', 'block', 'lot', 'features', 'contact_info'] as const) {
    if (body[field] !== undefined && body[field] !== null && typeof body[field] !== 'string') {
      return { error: `El campo "${field}" debe ser un texto.` };
    }
  }
  if (body.latitude !== undefined && body.latitude !== null) {
    if (typeof body.latitude !== 'number' || !Number.isFinite(body.latitude) || body.latitude < -90 || body.latitude > 90) {
      return { error: 'El campo "latitude" debe ser un número entre -90 y 90.' };
    }
  }
  if (body.longitude !== undefined && body.longitude !== null) {
    if (typeof body.longitude !== 'number' || !Number.isFinite(body.longitude) || body.longitude < -180 || body.longitude > 180) {
      return { error: 'El campo "longitude" debe ser un número entre -180 y 180.' };
    }
  }
  return {};
}

const router = express.Router();

// GET /api/catalog/properties: tabla interactiva. Filtros (operation, property_type, search sobre address)
// y ordenamiento (sort/order) por cualquier columna soportada, con paginación limit/offset — sin
// esto, una cartera de miles de filas (ver KAN-71, límite real de subida) se traería completa en
// cada carga de la tabla.
router.get('/api/catalog/properties', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const supabase = (req as any).supabaseClient;

  const { operation, property_type, search, sort, order, limit, offset } = req.query as Record<string, string | undefined>;

  if (operation !== undefined && !OPERATIONS.includes(operation as any)) {
    return res.status(400).json({ error: `El filtro "operation" debe ser uno de: ${OPERATIONS.join(', ')}.` });
  }
  if (property_type !== undefined && !PROPERTY_TYPES.includes(property_type as any)) {
    return res.status(400).json({ error: `El filtro "property_type" debe ser uno de: ${PROPERTY_TYPES.join(', ')}.` });
  }
  const sortField: SortableField = (SORTABLE_FIELDS as readonly string[]).includes(sort || '')
    ? (sort as SortableField)
    : 'created_at';
  const ascending = order === 'asc';

  let parsedLimit = 50;
  if (limit !== undefined) {
    const n = parseInt(limit, 10);
    if (isNaN(n) || n <= 0 || n > 200) {
      return res.status(400).json({ error: 'El parámetro "limit" debe ser un número entre 1 y 200.' });
    }
    parsedLimit = n;
  }
  let parsedOffset = 0;
  if (offset !== undefined) {
    const n = parseInt(offset, 10);
    if (isNaN(n) || n < 0) {
      return res.status(400).json({ error: 'El parámetro "offset" debe ser un número mayor o igual a 0.' });
    }
    parsedOffset = n;
  }

  try {
    let query = supabase
      .from('properties')
      .select(PROPERTY_SELECT, { count: 'exact' })
      .eq('tenant_id', tenantId);

    if (operation) query = query.eq('operation', operation);
    if (property_type) query = query.eq('property_type', property_type);
    if (search) query = query.ilike('address', `%${search}%`);

    query = query
      .order(sortField, { ascending })
      .range(parsedOffset, parsedOffset + parsedLimit - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    // Mismo patrón que GET /api/properties del panel admin (KAN-130): `zone_id` ya cacheado se usa
    // tal cual (0 llamadas extra vía el join embebido de arriba), y las filas sin caché se resuelven
    // juntas con un único RPC batch en vez de 1 round-trip por propiedad.
    const rows = data || [];
    const propertiesForBatch: PropertyForZoneBatch[] = rows.map((p: any) => ({
      latitude: p.latitude,
      longitude: p.longitude,
      address: p.address,
      features: p.features ?? undefined,
      sheet_name: p.sheet_name,
      cachedZone: p.neighborhoods ? { id: p.neighborhoods.id, name: p.neighborhoods.name } : null
    }));
    const zoneInfos = await resolvePropertiesZoneInfoBatch(propertiesForBatch);

    const properties = rows.map((p: any, idx: number) => {
      const { neighborhoods, zone_id, ...rest } = p;
      return { ...rest, zone: zoneInfos[idx].zone };
    });

    res.json({ properties, total: count || 0 });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[PROPERTIES] Error al listar propiedades');
    res.status(500).json({ error: 'Error interno al listar propiedades.' });
  }
});

// POST /api/catalog/properties: alta manual desde la UI (además del alta masiva vía Excel en upload.ts).
router.post('/api/catalog/properties', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const supabase = (req as any).supabaseClient;

  const bodyWhitelistError = validateBodyWhitelist(req.body, CREATE_FIELDS);
  if (bodyWhitelistError) {
    return res.status(400).json({ error: bodyWhitelistError });
  }

  const { error: validationError } = validateFields(req.body || {}, true);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    // Fase 1 pre-lanzamiento: cap de cartera del plan (ver src/config/planLimits.ts). Cheque
    // antes del insert para no depender de que el UNIQUE/CHECK de la tabla lo frene después.
    const { maxProperties } = await getTenantPlanLimits(tenantId, supabase);
    const currentCount = await countTenantProperties(tenantId, supabase);
    if (currentCount >= maxProperties) {
      return res.status(403).json({ error: `Llegaste al límite de propiedades de tu plan (${maxProperties}).` });
    }

    const payload = {
      address: req.body.address.trim(),
      floor: req.body.floor || null,
      unit: req.body.unit || null,
      block: req.body.block || null,
      lot: req.body.lot || null,
      price: req.body.price,
      currency: req.body.currency,
      maintenance_fees: req.body.maintenance_fees ?? 0,
      bedrooms: req.body.bedrooms ?? 0,
      features: req.body.features || null,
      contact_info: req.body.contact_info || null,
      operation: req.body.operation,
      property_type: req.body.property_type,
      latitude: req.body.latitude ?? null,
      longitude: req.body.longitude ?? null,
      // KAN-273: alta manual, no viene de una hoja de Excel — se documenta el origen para no
      // confundirla con una fila sincronizada, que sí tiene sheet_name real.
      sheet_name: 'Alta manual',
      tenant_id: tenantId
    };

    const { data, error } = await supabase
      .from('properties')
      .insert(payload)
      .select(PROPERTY_SELECT)
      .single();

    if (error) throw error;

    if (data.latitude !== null && data.longitude !== null) {
      try {
        await refreshZoneId(supabase, data.id, data.latitude, data.longitude, data.address, data.features, data.sheet_name);
        const { data: refreshed } = await supabase.from('properties').select(PROPERTY_SELECT).eq('id', data.id).single();
        if (refreshed) return res.status(201).json({ property: toPropertyResponse(refreshed) });
      } catch (zoneError: any) {
        logger.error({ err: zoneError.message, propertyId: data.id }, '[PROPERTIES] No se pudo resolver la zona al crear la propiedad');
      }
    }

    res.status(201).json({ property: toPropertyResponse(data) });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[PROPERTIES] Error al crear propiedad');
    res.status(500).json({ error: 'Error interno al crear la propiedad.' });
  }
});

// PATCH /api/catalog/properties/:id: edición desde la fila expandible. Concurrencia optimista vía
// expectedUpdatedAt (el updated_at que el cliente vio al leer la fila, ver migración
// kan273_add_properties_updated_at_concurrency) — si nadie más la tocó desde entonces, el
// .eq('updated_at', ...) matchea y el trigger de la tabla bumpea updated_at de nuevo al escribir;
// si otra edición ya pasó por acá, 0 filas afectadas -> 409 con el estado real actual para que el
// frontend pueda mostrarlo y el usuario decida cómo reconciliar.
router.patch('/api/catalog/properties/:id', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const id = req.params.id as string;
  const supabase = (req as any).supabaseClient;

  const bodyWhitelistError = validateBodyWhitelist(req.body, UPDATE_FIELDS);
  if (bodyWhitelistError) {
    return res.status(400).json({ error: bodyWhitelistError });
  }

  const { expectedUpdatedAt, ...fields } = req.body || {};
  if (typeof expectedUpdatedAt !== 'string' || expectedUpdatedAt.trim().length === 0) {
    return res.status(400).json({ error: 'El campo "expectedUpdatedAt" es requerido para editar una propiedad.' });
  }
  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'No se proveyeron campos para actualizar.' });
  }

  const { error: validationError } = validateFields(fields, false);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const updatePayload: Record<string, any> = {};
  for (const [key, value] of Object.entries(fields)) {
    updatePayload[key] = typeof value === 'string' && value.trim().length === 0 && key !== 'address' ? null : value;
  }
  if (typeof updatePayload.address === 'string') {
    updatePayload.address = updatePayload.address.trim();
  }

  try {
    const { data, error } = await supabase
      .from('properties')
      .update(updatePayload)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .eq('updated_at', expectedUpdatedAt)
      .select(PROPERTY_SELECT);

    if (error) throw error;

    if (!data || data.length === 0) {
      // No sabemos si es 404 (no existe/no es del tenant) o 409 (existe pero cambió). Se
      // distingue con una segunda lectura sin el filtro de updated_at, igual que hace cualquier
      // API REST con ETags/If-Match ante un precondition failed.
      const { data: current, error: fetchError } = await supabase
        .from('properties')
        .select(PROPERTY_SELECT)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .maybeSingle();

      if (fetchError) throw fetchError;

      if (!current) {
        return res.status(404).json({ error: 'Propiedad no encontrada.' });
      }
      return res.status(409).json({
        error: 'La propiedad fue modificada por otra persona desde que la cargaste. Volvé a intentar con los datos actuales.',
        property: toPropertyResponse(current)
      });
    }

    // KAN-305: latitude/longitude ya no están en UPDATE_FIELDS, así que este PATCH nunca las toca
    // — el refresh de zona por cambio de coordenadas queda solo del lado admin
    // (`PATCH /admin/api/properties/:id/coordinates`, ver adminRoutes.ts).
    res.json({ property: toPropertyResponse(data[0]) });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId, propertyId: id }, '[PROPERTIES] Error al actualizar propiedad');
    res.status(500).json({ error: 'Error interno al actualizar la propiedad.' });
  }
});

// POST /api/catalog/properties/:id/request_correction (KAN-305): el tenant ya no puede editar
// latitude/longitude directamente (ver UPDATE_FIELDS más arriba) — esta es la única vía que le
// queda para señalar una coordenada mal ubicada. Solo prende el flag `needs_coordinate_review`;
// las coordenadas actuales quedan sin tocar (siguen activas para matching/mapa) hasta que un admin
// las corrija de verdad vía `PATCH /admin/api/properties/:id/coordinates` (KAN-130), que ahora
// apaga el flag al guardar (ver adminRoutes.ts). Nota de path: el AC del ticket menciona
// `POST /api/properties/request_correction`, pero ese prefijo ya lo usa el panel admin
// (`GET /api/properties`, cross-tenant, mountAdminRouter se monta antes) — se sigue el mismo
// criterio ya documentado arriba para el resto de estas rutas y queda bajo
// `/api/catalog/properties/:id/request_correction` para no colisionar.
router.post('/api/catalog/properties/:id/request_correction', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const id = req.params.id as string;
  const supabase = (req as any).supabaseClient;

  try {
    const { data, error } = await supabase
      .from('properties')
      .update({ needs_coordinate_review: true })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select(PROPERTY_SELECT)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({ error: 'Propiedad no encontrada.' });
    }

    logger.info({ tenantId, propertyId: id }, '[PROPERTIES] Corrección de coordenadas solicitada');
    res.json({ property: toPropertyResponse(data) });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId, propertyId: id }, '[PROPERTIES] Error al solicitar corrección de coordenadas');
    res.status(500).json({ error: 'Error interno al solicitar la corrección de coordenadas.' });
  }
});

// DELETE /api/catalog/properties/:id
// KAN-306 (continuación, 2026-09-04): pedido explícito del usuario — un colaborador puede cargar,
// editar y ver la cartera de su agencia, pero NUNCA eliminar propiedades; solo el dueño real. La
// RLS (`properties_owner_delete`, `tenant_id = auth.uid()`, ver migración
// `add_agency_shared_tenant_scope_2026-09-04.sql`) ya lo bloquea a nivel de base, pero sin este
// chequeo previo un colaborador recibiría un 404 genérico en vez de un error claro — mismo patrón
// de "chequeo privilegiado antes de mutar" que ya usan archiveSearch/reactivateSearch en
// searchController.ts. Se usa `req.supabaseClient` (tenant-scoped, no el service-role) para leer
// el propio `role`: la RLS de `profiles` (`id = auth.uid()`) ya permite a cualquier actor leer su
// propia fila sin necesidad de privilegios elevados, y de paso este chequeo queda mockeable con
// el mismo fake client que el resto de esta suite de tests (a diferencia de
// `adminPanelController.ts`, que sí necesita service-role para las escrituras de `role`/
// `agency_owner_id`, columnas con `REVOKE UPDATE ... FROM authenticated`).
router.delete('/api/catalog/properties/:id', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const actorId = (req as any).actorId;
  const { id } = req.params;
  const supabase = (req as any).supabaseClient;

  try {
    const ownerCheck = await requireOwner(actorId, supabase, 'Solo el dueño de la agencia puede eliminar propiedades.');
    if (!ownerCheck.ok) {
      return res.status(ownerCheck.status).json({ error: ownerCheck.error });
    }

    const { data, error } = await supabase
      .from('properties')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select('id');

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Propiedad no encontrada.' });
    }

    res.json({ success: true });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId, actorId, propertyId: id }, '[PROPERTIES] Error al eliminar propiedad');
    res.status(500).json({ error: 'Error interno al eliminar la propiedad.' });
  }
});

export default router;
