# Feature: Refactorización de Calidad, Escalabilidad y Orden de Archivos (Spec 0009)

## Descripción
Esta feature incorpora mejoras en la infraestructura del proyecto, incluyendo la migración al gestor de paquetes `pnpm`, reorganización de la estructura de archivos en el disco, e implementación del Patrón Strategy para el motor de matching y Structured Outputs para OpenAI.

## Objetivos
1. Migrar la base del proyecto a `pnpm` para agilizar el tiempo de instalación y robustez de dependencias.
2. Desacoplar la lógica de matching en estrategias individuales (`IMatchingStrategy`) para eliminar condicionales complejos y anidados.
3. Configurar OpenAI con respuestas estructuradas (`json_schema`) para evitar fallos de parseo en el fallback de IA.
4. Reorganizar el directorio raíz moviendo la documentación a `docs/` y los archivos de caché generados en runtime a `cache/`.

## Tareas
- [x] Ejecutar la instalación limpia con `pnpm` y validar compilación.
- [x] Renombrar `gemini.ts` a `ai.ts` para reflejar soporte multiplataforma.
- [x] Implementar el Patrón Strategy en `src/utils/matcher.ts`.
- [x] Configurar Structured Outputs con `json_schema` en `src/services/ai.ts` para OpenAI.
- [x] Reubicar archivos en `docs/` y `cache/` y actualizar paths relativos en código.
- [x] Modificar `.gitignore` para ignorar la carpeta `cache/`.
