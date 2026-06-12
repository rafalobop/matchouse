# SPEC-0001: Estado del MVP Base de HouseMatch

## 1. Contexto y Estado del Arte
El MVP de HouseMatch está diseñado para capturar pedidos de propiedades inmobiliarias desde grupos de WhatsApp, procesar los requisitos mediante IA y realizar un cruzamiento automatizado con una base de datos de propiedades local (inicialmente cargada por Excel o sincronizada con Google Sheets).

### Componentes Actuales
1. **Conexión a WhatsApp (`baileys`)**: Listener en tiempo real de mensajes en grupos seleccionados.
2. **Filtro Estático (`src/utils/filter.ts`)**: Pre-filtro basado en expresiones regulares para descartar mensajes que no sean pedidos explícitos.
3. **Agente 1 (Extractor - `src/services/gemini.ts`)**: Mapea campos clave del pedido (operación, tipo de propiedad, presupuesto, moneda, dormitorios, características).
4. **Agente 2 (Geolocalizador - `src/services/gemini.ts`)**: Resuelve e identifica la zona geográfica usando un listado estático predefinido de zonas y límites geográficos de Tucumán.
5. **Motor de Match (`src/utils/matcher.ts`)**: Algoritmo puro de negocio que realiza filtros estrictos (operación, dormitorios, zonas, conversión de dólares a valor blue, exclusión/inclusión de countries/barrios cerrados).
6. **Persistencia / Sincronización**:
   - Lectura local de Excel cargado mediante dashboard -> Caché local (`catalog.json`).
   - Sincronización en la nube mediante Google Sheets API para persistir los matches generados.

## 2. Decisión de Diseño Inicial
- **Pipeline Lineal**: El procesamiento de mensajes entrantes fluye de forma secuencial: `Filtro -> Extractor (Agente 1) -> Geolocalizador (Agente 2) -> Matcher -> Notificación`.
- **Estrategia de Fallback de IA**: Uso principal del SDK de Google Gemini con el modelo `gemini-2.5-flash-lite`. Si falla, existe un fallback dinámico hacia OpenAI (`gpt-4o-mini`).

## 3. Limitaciones Identificadas en el MVP
- La base de datos es plana (Excel/Google Sheets) y se lee a memoria/JSON local.
- No hay persistencia relacional ni control robusto de estados para reintento de notificaciones o logs históricos de matches a nivel de base de datos relacional.
- La lógica de negocio está fuertemente acoplada en un flujo lineal en `src/index.ts`.
- La detección de ubicación depende estrictamente de un mapeo con límites geométricos fijos definidos en `zones.ts` y del prompt del Agente 2.
