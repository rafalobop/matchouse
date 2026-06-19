-- 1. Modificar tabla Tenant para soportar control de sesión único
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "active_session_token" TEXT;

-- 2. Habilitar RLS en las tablas
ALTER TABLE "Tenant" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Property" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Message" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Match" FORCE ROW LEVEL SECURITY;

-- 3. Eliminar políticas existentes si las hubiera para evitar duplicados
DROP POLICY IF EXISTS tenant_self_policy ON "Tenant";
DROP POLICY IF EXISTS property_tenant_policy ON "Property";
DROP POLICY IF EXISTS message_tenant_policy ON "Message";
DROP POLICY IF EXISTS match_tenant_policy ON "Match";

-- 4. Crear Políticas de RLS
-- Un tenant sólo puede leer/editar su propio registro
CREATE POLICY tenant_self_policy ON "Tenant"
  FOR ALL TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- Separación estricta por tenant_id
CREATE POLICY property_tenant_policy ON "Property"
  FOR ALL TO authenticated
  USING (tenant_id = auth.uid())
  WITH CHECK (tenant_id = auth.uid());

CREATE POLICY message_tenant_policy ON "Message"
  FOR ALL TO authenticated
  USING (tenant_id = auth.uid())
  WITH CHECK (tenant_id = auth.uid());

CREATE POLICY match_tenant_policy ON "Match"
  FOR ALL TO authenticated
  USING (tenant_id = auth.uid())
  WITH CHECK (tenant_id = auth.uid());
