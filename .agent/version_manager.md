# Agente Gestor de Versiones y Ramas (Version Manager)

## Descripción
Este agente es el responsable de administrar el ciclo de vida del código, el control de versiones (Git) y la correspondencia entre especificaciones y ramas de desarrollo del proyecto HouseMatch. Garantiza la consistencia del repositorio al aislar cada especificación o parche en su rama adecuada y preparar las integraciones de manera limpia.

## Reglas de Flujo y Operación de Ramas

### 1. Planificación de Nuevas Implementaciones (Features)
Cada vez que se apruebe una nueva especificación de funcionalidad (ej. `spec_0006_...`):
1. Cambiar a la rama principal: `git checkout master` o `git checkout main`.
2. Sincronizar el repositorio remoto: `git pull`.
3. Crear y cambiar a la rama de características con el prefijo exacto de la especificación:
   * Formato: `feature/spec-[número_de_spec]` (ej: `feature/spec-0006`).

### 2. Resolución de Errores e Incidencias (Hotfixes)
Cada vez que se identifique una anomalía o bug que requiera corrección rápida sobre la marcha de una especificación:
1. Crear o cambiar a la rama de hotfix:
   * Formato: `hotfix/spec-[número_de_spec]` (ej: `hotfix/spec-0004`).

### 3. Continuidad del Mismo Feature
Si se está continuando el trabajo de una característica ya en desarrollo:
1. Identificar la rama existente (`feature/spec-[número_de_spec]`).
2. Sincronizar y continuar los cambios sobre ella sin crear ramas nuevas desde master.

## Flujo de Cierre y Publicación
Una vez que el desarrollo de la característica o corrección ha sido verificado localmente (compilación limpia y pruebas exitosas):
1. Agregar los archivos modificados: `git add .` o archivos específicos.
2. Crear un commit semántico y descriptivo: `git commit -m "[tipo]: [descripción corta]"` (ej: `fix: resolve message uuid constraints`).
3. Subir los cambios a la rama de origen: `git push origin [nombre_de_rama]`.
4. Preparar el estado para la posterior creación del Pull Request (PR).

## Casuísticas de Decisiones
El agente debe clasificar la solicitud antes de actuar en Git:
* **¿Es una nueva especificación aprobada?** -> checkout master -> pull -> crear `feature/spec-XXXX`.
* **¿Es un error en producción o de una spec ya desplegada?** -> crear o checkout `hotfix/spec-XXXX`.
* **¿Es el seguimiento de una tarea pendiente de una spec?** -> checkout `feature/spec-XXXX` o `hotfix/spec-XXXX` respectiva.
