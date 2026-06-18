# Especificación 0009: Refactorización de Calidad, Escalabilidad y Orden de Archivos

Este documento detalla la especificación técnica e implementación realizada para eliminar deuda técnica, estructurar el motor de coincidencia inmobiliaria mediante patrones de diseño conocidos, robustecer las integraciones de IA con tipos estructurados y limpiar la estructura del directorio raíz.

---

## 1. Contexto y Objetivos
A medida que la arquitectura multi-tenant del MVP de HouseMatch se consolida, surgieron necesidades de mantenimiento evolutivo:
- **Deuda Técnica:** El motor de matching contenía múltiples condicionales lineales acoplados y anidados que dificultan la legibilidad y escalabilidad.
- **Inconsistencia de Respuestas de IA:** El fallback hacia OpenAI usaba JSON genérico en lugar de tipados estrictos, lo que exponía al sistema a alucinaciones de esquema.
- **Desorden de Directorio Raíz:** Los archivos dinámicos generados en tiempo de ejecución (caches de grupos, catálogos, configuraciones) y los archivos de documentación ensuciaban la raíz del proyecto.
- **Eficiencia de Dependencias:** Necesidad de migrar al gestor de paquetes `pnpm` para evitar dependencias fantasmas en TypeScript.

---

## 2. Decisiones de Diseño Técnico

### A. Patrón Strategy en el Motor de Matching (`src/utils/matcher.ts`)
* **Desacoplamiento:** Rediseñamos el comparador implementando el patrón de comportamiento **Strategy**.
* **Estrategias Individuales (`IMatchingStrategy`):** Dividimos el matching en 7 clases autónomas:
  - `OperationMatchingStrategy` (Venta/Alquiler)
  - `PropertyTypeMatchingStrategy` (Tipo de propiedad)
  - `CountryMatchingStrategy` (Filtro de country)
  - `ZoneMatchingStrategy` (Geolocalización o zonas generales)
  - `BedroomsMatchingStrategy` (Dormitorios requeridos)
  - `BudgetMatchingStrategy` (Presupuestos y conversión de monedas)
  - `FeaturesMatchingStrategy` (Características y comodidades)
* **Iteración Secuencial:** La función principal `checkMatch` ahora es un bucle simplificado sobre las estrategias que aplica un atajo rápido (*short-circuit*) ante descartes críticos.

### B. OpenAI Structured Outputs (`src/services/ai.ts`)
* **Esquemas Estrictos:** Actualizamos la estrategia de OpenAI (`OpenAIStrategy`) para usar **Structured Outputs** mediante la especificación de `json_schema` en el parámetro `response_format`.
* **Garantía de Contratos:** Esto fuerza al modelo `gpt-4o-mini` a responder exactamente con la estructura de JSON estructurada (con `additionalProperties: false`), garantizando resiliencia y el mismo nivel de robustez que Gemini.

### C. Ordenamiento de Estructura de Directorios
* **Carpeta de Documentos (`docs/`):** Movimiento de archivos de especificaciones, features e histórico de evolución al directorio `docs/` para despejar el espacio de trabajo.
* **Carpeta de Caché Local (`cache/`):** Redireccionamiento en código para que la escritura de JSONs de sesión, catálogos locales y logs temporales se realice en la subcarpeta `cache/`, agregando la misma al `.gitignore`.

---

## 3. Impacto en Componentes
* **`src/services/ai.ts`** [MODIFY]: Implementación de esquemas JSON Schema y Structured Outputs para OpenAI.
* **`src/services/coordinator.ts`** [MODIFY]: Eliminación de requires inline y cambio a importaciones estáticas del cliente Supabase.
* **`src/utils/matcher.ts`** [MODIFY]: Refactorización completa del motor a través del patrón Strategy.
* **`src/services/excel.ts` y `src/services/whatsapp.ts`** [MODIFY]: Cambio de rutas relativas hacia la carpeta `cache/` para almacenar configuraciones temporales.
