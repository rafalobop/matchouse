# Feature: Persistencia de Datos con PostgreSQL y Prisma

## Descripción
Esta feature reemplaza la caché en memoria y archivos estáticos JSON con una base de datos PostgreSQL gestionada mediante Prisma ORM.

## Objetivos
1. Instalar y configurar Prisma (`prisma init`).
2. Definir el esquema de base de datos para `Property`, `Message` y `Match`.
3. Sincronizar automáticamente el catálogo de Google Sheets o cargas de Excel en la base de datos relacional.
4. Persistir cada mensaje y match procesado.

## Tareas
- [x] Instalar `@prisma/client` y configurar el provider en `schema.prisma`.
- [x] Correr la migración inicial.
- [x] Crear la lógica de sincronización en `src/services/sheets.ts` y `src/services/excel.ts` hacia PostgreSQL.
- [x] Modificar el coordinador para almacenar cada `PipelineContext` (mensajes, matches) en las tablas relacionales.
