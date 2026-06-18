# Feature: Robustez e Idempotencia en Supabase (Spec 0005)

## Descripción
Esta feature incorpora seguridad transaccional e idempotencia en el procesamiento de mensajes de WhatsApp y la sincronización de propiedades de la cartera.

## Objetivos
1. Registrar e identificar cada mensaje de WhatsApp usando su ID único nativo (`msg.key.id`) para evitar reprocesamientos redundantes y llamadas innecesarias a las APIs de IA.
2. Evitar el vaciado temporal del catálogo de propiedades durante sincronizaciones de Excel/Google Sheets.
3. Clasificar propiedades entrantes de forma atómica en base a su clave comercial (`domicilio + pisoLote + sheetName`) y realizar inserciones, actualizaciones y eliminaciones incrementales (Upsert) en Supabase.
