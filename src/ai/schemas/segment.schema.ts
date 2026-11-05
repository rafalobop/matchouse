import { z } from 'zod';

// BE-06: schema de salida del Agente 0 (segmentador de mensajes multi-búsqueda) — divide un
// mensaje que describe 2+ pedidos independientes en N sub-textos autocontenidos.
//
// BE-12 (EP-03): rango plausible de salida — el input ya está acotado a 1000 caracteres
// (`validateFreeSearchText`), así que ningún segmento legítimo (un fragmento autocontenido DEL
// mismo mensaje) puede superarlo; se deja algo de margen (2000) para el caso de un pedido con una
// sola búsqueda, donde `toSegments` devuelve el texto original completo tal cual. Tope de cantidad
// (20) para no persistir una `active_searches` por fila ante una respuesta patológica del modelo —
// en la práctica ningún mensaje real describe más de un puñado de pedidos distintos.
export const SegmentSchema = z.object({
  segments: z.array(z.string().max(2000)).max(20)
});

export type SegmentLlmOutput = z.infer<typeof SegmentSchema>;
