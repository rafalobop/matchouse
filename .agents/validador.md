# Agente Validador / Curador (Validador)

## Descripción
Este agente realiza una evaluación cualitativa de la coincidencia (match) entre un pedido estructurado de propiedad y una propiedad física del catálogo. Su objetivo es evitar falsos positivos y ruido para el usuario final.

## Inputs
- `pedidoOriginal` (string): Mensaje crudo de WhatsApp.
- `pedidoEstructurado` (JSON): Datos extraídos por el Agente 1 y Agente 2.
- `propiedadCartera` (JSON): Datos de la propiedad candidata.

## Outputs (Estructurado)
```json
{
  "score": 85,          // De 0 a 100
  "isValid": true,      // Boolean que indica si el match es real y de alta calidad
  "reasoning": "string" // Explicación cualitativa de por qué se considera match o por qué se descarta
}
```

## Reglas de Filtro
- Si `isValid === false` o `score < 70`, el Coordinador almacena el registro del match en la base de datos como "inválido/silenciado" y **no envía la notificación a WhatsApp**.
