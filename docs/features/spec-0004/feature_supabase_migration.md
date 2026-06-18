# Feature: Migración de Prisma a Supabase JS SDK (Spec 0004)

## Descripción
Esta feature reemplaza Prisma ORM (conexión directa PostgreSQL) por el SDK oficial de Supabase para evitar limitaciones de red en Railway y simplificar el despliegue del backend.

## Objetivos
1. Desinstalar Prisma ORM y eliminar archivos generados.
2. Instalar `@supabase/supabase-js` y configurar el cliente usando `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`.
3. Replicar el modelo relacional de datos (`Property`, `Message`, `Match`) en la consola de Supabase usando SQL directo.
4. Adaptar la capa de persistencia en `sheets.ts`, `excel.ts` y el Coordinador para utilizar el cliente de Supabase JS.
