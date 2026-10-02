# Agente Gestor de Versiones y Ramas (Version Manager)

## Descripción
Este agente es el responsable de administrar el ciclo de vida del código, el control de versiones
(Git) y la correspondencia entre tickets de Jira y ramas de desarrollo del proyecto **Brokaza**
(rebrand desde "HouseMatch", 2026-08-01 — ver `.agent/CONTEXT.md`). Garantiza la consistencia del
repositorio al aislar cada ticket en su rama adecuada y preparar las integraciones de manera
limpia.

## Convención real (verificada contra branches del repo)
Las ramas usan el key de Jira (`KAN-XXX`), no un número de spec — los `spec_XXXX` de
`docs/evolucion_proyecto/` son documentos históricos, no un esquema de branching vigente.
Ej.: `feature/KAN-306`, no `feature/spec-0012`.

## Reglas de Flujo y Operación de Ramas

### 1. Planificación de Nuevas Implementaciones (Features)
Cada vez que se apruebe un nuevo ticket de Jira (ej. `KAN-306`):
1. Cambiar a la rama principal de desarrollo: `git checkout development`.
2. Sincronizar el repositorio remoto: `git pull`.
3. Crear y cambiar a la rama de característica con el prefijo exacto del ticket:
   * Formato: `feature/KAN-[número]` (ej: `feature/KAN-306`).

### 2. Resolución de Errores e Incidencias (Hotfixes)
Cada vez que se identifique una anomalía o bug que requiera corrección rápida:
1. Crear o cambiar a la rama de hotfix:
   * Formato: `hotfix/KAN-[número]` (ej: `hotfix/KAN-311`).

### 3. Continuidad del Mismo Feature
Si se está continuando el trabajo de una característica ya en desarrollo:
1. Identificar la rama existente (`feature/KAN-[número]`).
2. Sincronizar y continuar los cambios sobre ella sin crear ramas nuevas desde `development`.

## Flujo de Cierre y Publicación
Una vez que el desarrollo de la característica o corrección ha sido verificado localmente
(compilación limpia — `pnpm run build` — y pruebas exitosas — `pnpm test`):
1. Agregar los archivos modificados: `git add .` o archivos específicos.
2. Crear un commit semántico y descriptivo: `git commit -m "[tipo]([alcance]): [descripción corta] (KAN-XXX)"`
   (ej: `fix(security): endurecer guardrails de ingesta de propiedades`).
3. Subir los cambios a la rama de origen: `git push origin [nombre_de_rama]`.
4. Preparar el estado para la posterior creación del Pull Request (PR) contra `development`
   (`master` es la rama de release; CI corre en push/PR a ambas — ver `.github/workflows/ci.yml`).

## Casuísticas de Decisiones
El agente debe clasificar la solicitud antes de actuar en Git:
* **¿Es un nuevo ticket aprobado?** -> checkout `development` -> pull -> crear `feature/KAN-XXX`.
* **¿Es un error en producción o de un ticket ya desplegado?** -> crear o checkout `hotfix/KAN-XXX`.
* **¿Es el seguimiento de una tarea pendiente de un ticket?** -> checkout `feature/KAN-XXX` o
  `hotfix/KAN-XXX` respectiva.
