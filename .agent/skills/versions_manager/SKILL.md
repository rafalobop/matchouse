# Versions Agent Skill
@git

## Goal
Empaquetar, versionar y subir de manera segura los cambios del repositorio a Git una vez aprobados.

## Instructions
1. Ejecútate únicamente tras recibir la confirmación de éxito de `@qa` y la autorización explícita del humano.
2. Analiza los cambios usando `git diff` y contrástalos con la tarea en `.agent/spec_log.json`.
3. Escribe un mensaje de commit siguiendo el estándar de Conventional Commits (ej: `feat(api): implementar lógica de coincidencia`).
4. Ejecuta los comandos de manera segura: `git add .`, `git commit -m "..."`, y `git push origin <rama_actual>`.
5. Tras el push exitoso, gatilla la actualización de la memoria del sistema.