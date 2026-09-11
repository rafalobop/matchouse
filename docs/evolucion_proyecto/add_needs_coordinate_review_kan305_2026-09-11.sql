-- KAN-305: restringir la edición de latitud/longitud al admin y agregar un flujo de "solicitar
-- corrección" para tenants. Hoy `PATCH /api/catalog/properties/:id` (src/routes/properties.ts)
-- aceptaba latitude/longitude en el whitelist igual que cualquier otro campo editable por el
-- tenant, y el frontend (PropertyForm.tsx) tenía un pin arrastrable — cualquier tenant podía
-- pisar el geocoding curado sin pasar por el flujo de corrección auditado que ya existe del lado
-- admin (`PATCH /admin/api/properties/:id/coordinates`, KAN-130, con audit log en
-- admin_audit_log). Esta columna es el flag que conecta ambos lados: el tenant la prende via el
-- nuevo `POST /api/catalog/properties/:id/request_correction` (sin tocar lat/lng, que quedan
-- intactas durante la revisión), el admin la ve en `GET /admin/api/properties` para priorizar
-- qué corregir, y el propio PATCH de coordinates la apaga al guardar la corrección.

ALTER TABLE public.properties
  ADD COLUMN needs_coordinate_review boolean NOT NULL DEFAULT false;
