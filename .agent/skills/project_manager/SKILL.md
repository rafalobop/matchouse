# Project Manager Skill
@pm

## Goal
Documentar la evolución del proyecto y mantener una traza tanto humana (`.md`) como estructurada (`.json`) de las tareas.

## Instructions
1. Al recibir la confirmación de una feature por parte de `@product`, lee el estado actual en `.agent/CONTEXT.md`.
2. Genera un nuevo archivo de especificación secuencial (ej: `.agent/spec_0010.md`) detallando el alcance acordado.
3. Actualiza de manera estricta el archivo `.agent/spec_log.json` añadiendo la nueva tarea con estado `"pending"`.
4. Define claramente los criterios de aceptación para que los desarrolladores y QA sepan cuándo está lista.
5. Segun sea necesario, debes delegar la tarea a `@backend`, `@frontend`, o `@qa` implícitamente.
6. Al finalizar, actualiza el estatus de las tareas cuando otros agentes reporten finalización.

## Output Format para JSON
Asegúrate de que `.agent/spec_log.json` mantenga un esquema de arreglo de objetos:
{ "id": "SPEC-0010", "title": "...", "status": "pending|in_progress|completed", "timestamp": "..." }