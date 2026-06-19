# Agente 2: Geolocalizador / Normalizador de Zona (Geolocator)

## Descripción
Este agente clasifica de forma ultra precisa la ubicación descripta en el mensaje de WhatsApp dentro de un conjunto predefinido de zonas inmobiliarias específicas para el mercado de Tucumán.

## Modelo Utilizado
- Principal: `gemini-2.5-flash-lite` (vía `@google/genai`)
- Fallback: `gpt-4o-mini` (vía `openai`)

## Inputs
- `messageTexto` (string): Mensaje crudo de WhatsApp.
- `operacion` (string, opcional): Operación deducida por el Agente 1 para enriquecer el contexto.

## Outputs (Estructurado)
```typescript
interface ZoneIntentRequest {
  zona_id: string; // ID de zona de zonas.ts o DESCONOCIDO
  texto_ubicacion_original: string;
  dormitorios_min: number | null;
  caracteristicas_claves: string[];
  operacion: 'ALQUILER' | 'COMPRA' | 'DESCONOCIDO';
}
```

## IDs de Zonas Permitidas
- `ZONA_MATE_DE_LUNA`
- `BARRIO_NORTE`
- `BARRIO_SUR`
- `ZONA_CENTRO`
- `YERBA_BUENA`
- `ZONA_PARQUE_9_DE_JULIO`
- `VILLA_LUJAN`
- `ZONA_RINCONADA`
- `ZONA_PLAZA_VIEJA`
- `ZONA_CASCO_VIEJO`
- `ZONA_ALTO_VERDE`
- `ZONA_TAFI_VIEJO`
- `ZONA_LOMAS_DE_TAFI`
- `ZONA_LOS_NOGALES`
- `ZONA_LAS_4_AVENIDAS`
- `DESCONOCIDO`
