# SPEC-0007: Curación de Matches e Interfaz de Feedback

## 1. Contexto y Justificación
Para mejorar la precisión del filtrado algorítmico y del agente validador cognitivo (Gemini), se requiere una vía para capturar la retroalimentación de los operadores humanos. Esta especificación describe el sistema de curación en el cual los matches sugeridos pueden ser aceptados o rechazados directamente desde el Dashboard, almacenando la acción y los motivos de rechazo correspondientes.

## 2. Especificación Técnica

### 2.1. Estructura de Persistencia (Supabase)
Se agregaron las siguientes columnas a la tabla `Match`:
* **`userReviewStatus`** (TEXT): Estados posibles: `'PENDING'`, `'ACCEPTED'`, `'REJECTED'`. Valor predeterminado: `'PENDING'`.
* **`feedbackReason`** (TEXT): Almacena el motivo en caso de rechazo (`NULL` por defecto).

### 2.2. Flujo e Interfaz de Usuario
1. **Endpoint de Actualización**: Se implementó la ruta `POST /api/matches/:id/feedback` en `index.ts` que permite guardar la curación en base de datos.
2. **Visualización de Curation en el Dashboard**:
   * Las filas de matches ahora disponen de una columna "Curación".
   * Si el estado es `'PENDING'`, se muestran botones de **Aceptar** y **Rechazar**.
   * Al hacer clic en **Aceptar**, la fila se resalta en verde y el estado pasa a `'ACCEPTED'`.
   * Al hacer clic en **Rechazar**, se despliega un modal elegante que consulta el motivo del rechazo (ej. *Mal filtrado*, *Zona incorrecta*, *Otro* con campo de texto libre). Al confirmar, la fila se atenúa en rojo con opacidad reducida y muestra la justificación.

## 3. Impacto en los Componentes
* **`src/index.ts`**: Actualización de la consulta GET y definición del endpoint de feedback.
* **`src/dashboard/index.html`**: Estructura de la columna en la tabla y definición del modal de motivos de rechazo.
* **`src/dashboard/app.js`**: Lógica de envío de peticiones asíncronas y renderizado dinámico de la tabla.
* **`src/dashboard/style.css`**: Estilos del modal, radio buttons, badges de estado y diseño de filas aceptadas/rechazadas.
