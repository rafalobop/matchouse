# Especificación 0008: Evolución Multi-Tenant, Seguridad Avanzada y Notificación Consolidada

Este documento detalla la especificación técnica y las decisiones de diseño arquitectónico implementadas para transformar HouseMatch de una aplicación mono-tenant a una arquitectura multi-tenant de hasta 10 clientes con blindaje de IA y notificaciones anti-baneo.

---

## 1. Contexto y Objetivos
A medida que el MVP madura, surgió la necesidad de permitir que múltiples inmobiliarias (Tenants) utilicen el sistema de forma aislada y segura, compartiendo la misma infraestructura (base de datos en Supabase y servidor NodeJS en Railway) pero sin cruce de información.
Adicionalmente, se buscaba blindar las llamadas a los modelos de lenguaje (LLM) contra ataques de *Prompt Injection* y mitigar el riesgo de baneo de cuentas de WhatsApp debido al envío de ráfagas automáticas de mensajes.

---

## 2. Decisiones de Diseño Técnico

### A. Autenticación Dinámica por IP ("Zero-Login OTP IP-Binding")
Para evitar la complejidad de implementar un sistema tradicional de cuentas (registro, contraseñas, tokens JWT), diseñamos un sistema de vinculación basado en IP:
- **Aislamiento en DB:** La tabla `Tenant` registra el número de teléfono del bot (`phone_number`), la IP asociada (`associated_ip`), y la fecha de vinculación (`ip_bound_at`).
- **Expiración de 12 Horas:** El acceso al Dashboard expira automáticamente tras 12 horas desde la vinculación de la IP.
- **Flujo OTP por WhatsApp:** Si una IP es desconocida o expira, el Dashboard solicita el número de teléfono del bot. El sistema genera un código OTP de 6 dígitos de un solo uso y lo envía de forma privada al WhatsApp del propietario a través del bot. Al verificar el OTP, se vincula la nueva IP y se anulan las vinculaciones anteriores, previniendo el uso compartido de la sesión.
- **Límite Estricto de 10 Tenants:** Se restringe en la base de datos y al crear la sesión el registro de un máximo de 10 Tenants activos simultáneos.

### B. Inicialización Dinámica de Sockets (Baileys Multi-Sesión)
Refactorizamos el cliente de WhatsApp para mantener múltiples sockets de conexión activos en paralelo:
- **Almacenamiento Aislado:** Las credenciales de sesión de Baileys se guardan en rutas parametrizadas: `sessions/tenant_${tenantId}`.
- **Arranque en Caliente:** Al arrancar el servidor NodeJS, se consultan todos los Tenants registrados y se inician sus sesiones de WhatsApp de manera asíncrona.
- **Configuraciones por Tenant:** La caché de grupos y las configuraciones de filtros se guardan en archivos locales dedicados: `groups_cache_${tenantId}.json` y `settings_${tenantId}.json`.

### C. Securización contra Prompt Injection y Jailbreaking
Blindamos los prompts de los agentes de Inteligencia Artificial (Extractor y Validador) en `src/services/gemini.ts`:
- **Aislamiento por Etiquetas XML:** Todo el contenido ingresado por terceros no confiables (mensajes de WhatsApp del chat) se encapsula dentro de etiquetas delimitadoras como `<USER_CHAT>` y `<PEDIDO_CLIENTE_TEXTO>`.
- **Cláusulas de Inmunidad Operativa:** Se agregaron instrucciones explícitas en el Prompt del Sistema que ordenan al LLM ignorar cualquier instrucción, rol alternativo o comando operativo incrustado dentro de los datos de entrada del usuario.

### D. Notificaciones Consolidadas Anti-Baneo
Eliminamos las notificaciones inmediatas por cada match para evitar ráfagas automatizadas (comportamiento de bot):
- **Matches en Estado PENDING:** Al calificar un match, el Coordinador lo registra en Supabase con el estado `notification_status = 'PENDING'`.
- **Servicio Notificador Asíncrono (`notifier.ts`):** Un hilo en background se ejecuta cada 10 minutos (parametrizable por `NOTIFICATION_INTERVAL_MINUTES`). Agrupa los matches pendientes por Tenant, simula la escritura humana en WhatsApp durante 2 a 4 segundos, y envía un reporte resumido.
- **Rotación de Plantillas:** El notificador rota aleatoriamente entre **5 plantillas estilísticas distintas**, asegurando que un mismo Tenant nunca reciba la misma plantilla consecutivamente.

---

## 3. Impacto en el Modelo de Datos (Supabase)
- **`Tenant` (Nueva Tabla):** UUID Primary Key, JID del bot, IP vinculada, código OTP y expiración.
- **`Property`:** Añadida clave foránea `tenant_id` (NOT NULL).
- **`Message`:** Añadida clave foránea `tenant_id` (NOT NULL). Clave primaria compuesta por `(id, tenant_id)`.
- **`Match`:** Añadida clave foránea `tenant_id` (NOT NULL) y columna `notification_status` (PENDING / SENT).
