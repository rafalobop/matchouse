# SPEC-0004: Migración de Prisma a Supabase JS SDK

## 1. Contexto y Justificación
Debido a las limitaciones de ruteo de red IPv6 de Railway y para simplificar drásticamente la infraestructura, se decide migrar del ORM Prisma (conexión directa PostgreSQL/TCP) al SDK oficial de Supabase (`@supabase/supabase-js`), que opera sobre HTTPS/REST (puerto 443).

Esto elimina:
- Errores de red tipo `ENETUNREACH`.
- Necesidad de gestionar connection poolers complejos.
- El build-step adicional de `prisma generate`.

## 2. Requisitos de Configuración (Acción del Usuario)

El usuario deberá agregar dos variables en su archivo `.env` en Railway y en desarrollo local:
*   `SUPABASE_URL`: La URL de la API del proyecto de Supabase (ej: `https://bbadahhljpddlckyrmvi.supabase.co`).
*   `SUPABASE_SERVICE_ROLE_KEY`: La clave secreta de rol de servicio (Service Role Key) para permitir que el backend eluda políticas de Row-Level Security (RLS) y gestione los datos directamente.

## 3. Script SQL para Crear Tablas (Supabase SQL Editor)
El usuario debe copiar y ejecutar el siguiente script en el **SQL Editor** de su consola de Supabase:

```sql
-- Habilitar extensión UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Crear tabla de Propiedades
CREATE TABLE IF NOT EXISTS "Property" (
  "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  "domicilio" TEXT NOT NULL,
  "pisoLote" TEXT,
  "precio" DOUBLE PRECISION NOT NULL,
  "moneda" TEXT NOT NULL,
  "expensas" DOUBLE PRECISION DEFAULT 0,
  "dormitorios" INTEGER DEFAULT 0,
  "caracteristicas" TEXT,
  "contacto" TEXT,
  "zona" TEXT NOT NULL,
  "operacion" TEXT NOT NULL,
  "tipoPropiedad" TEXT NOT NULL,
  "sheetName" TEXT NOT NULL,
  "latitud" DOUBLE PRECISION,
  "longitud" DOUBLE PRECISION,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Crear tabla de Mensajes
CREATE TABLE IF NOT EXISTS "Message" (
  "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  "body" TEXT NOT NULL,
  "sender" TEXT NOT NULL,
  "groupName" TEXT NOT NULL,
  "senderPhone" TEXT NOT NULL,
  "timestamp" TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Crear tabla de Matches
CREATE TABLE IF NOT EXISTS "Match" (
  "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  "messageId" UUID NOT NULL REFERENCES "Message"("id") ON DELETE CASCADE,
  "propertyId" UUID NOT NULL REFERENCES "Property"("id") ON DELETE CASCADE,
  "score" DOUBLE PRECISION NOT NULL,
  "validationScore" DOUBLE PRECISION NOT NULL,
  "isValid" BOOLEAN NOT NULL,
  "reasoning" TEXT NOT NULL,
  "matchDetails" TEXT NOT NULL,
  "fecha" TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
```

## 4. Impacto en Componentes y Agentes
*   **Agente Coordinador**: Seguirá registrando la trazabilidad de los mensajes y matches de igual manera, pero utilizando la interfaz simple de `@supabase/supabase-js`.
*   **No se requiere un nuevo agente**: Es una migración puramente estructural y de adaptadores de persistencia, manteniendo la lógica cognitiva del sistema intacta.
