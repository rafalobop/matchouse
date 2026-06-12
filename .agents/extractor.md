# Agente 1: Extractor de Entidades (Extractor)

## Descripción
Este agente es el encargado de procesar los mensajes entrantes de WhatsApp filtrados previamente. Extrae entidades del negocio estructuradas para el sector inmobiliario en Tucumán.

## Modelo Utilizado
- Principal: `gemini-2.5-flash-lite` (vía `@google/genai`)
- Fallback: `gpt-4o-mini` (vía `openai`)

## Inputs
- `messageTexto` (string): Mensaje crudo recibido de WhatsApp.

## Outputs (Estructurado)
```typescript
interface ExtractedRealEstateRequest {
  operacion: 'venta' | 'alquiler' | 'desconocido';
  tipo_propiedad: 'departamento' | 'casa' | 'terreno' | 'local' | 'oficina' | 'otro';
  zonas: string[];
  presupuesto_max: number | null;
  moneda: 'USD' | 'ARS' | 'desconocido';
  dormitorios: number | null;
  caracteristicas_clave: string[];
  country: 'si' | 'no' | 'indiferente';
}
```

## Reglas de Negocio Clave
1. **Operación**: Determina si es venta o alquiler. Si no es explícito, busca términos secundarios como "Busco", "Necesito", etc.
2. **Ubicaciones Básicas**: Normaliza a municipios principales ("San Miguel de Tucumán", "Yerba Buena", "Tafí Viejo").
3. **Presupuesto y Moneda**: Deduce moneda por el tipo de operación si no se especifica (compra -> USD, alquiler -> ARS).
4. **Country**: Identifica si se solicita estar dentro ("si"), fuera ("no") o si es indiferente.
