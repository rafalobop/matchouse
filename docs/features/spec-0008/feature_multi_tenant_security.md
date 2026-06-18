# Feature: Evolución Multi-Tenant, Seguridad y Notificación Consolidada (Spec 0008)

## Descripción
Esta feature amplía el sistema a una arquitectura multi-tenant (soporte hasta 10 inmobiliarias), implementa protección contra ataques de inyección en prompts de IA, y un sistema anti-baneo de WhatsApp mediante notificaciones consolidadas cada 10 minutos.

## Objetivos
1. Diseñar el aislamiento multi-tenant en Supabase (tabla `Tenant`, relación con `Property`, `Message`, `Match`).
2. Configurar sesiones aisladas de WhatsApp en Baileys por tenant (`sessions/tenant_${tenantId}`).
3. Implementar seguridad OTP por IP para acceso al Dashboard sin login tradicional.
4. Desarrollar un servicio notificador consolidado (`notifier.ts`) para espaciar los mensajes y evitar patrones de comportamiento robótico que resulten en ban de WhatsApp.
5. Blindar los prompts del Extractor y Validador en `ai.ts` con inmunidades y etiquetas XML.
