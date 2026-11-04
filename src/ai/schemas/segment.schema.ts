import { z } from 'zod';

// BE-06: schema de salida del Agente 0 (segmentador de mensajes multi-búsqueda) — divide un
// mensaje que describe 2+ pedidos independientes en N sub-textos autocontenidos.
export const SegmentSchema = z.object({
  segments: z.array(z.string())
});

export type SegmentLlmOutput = z.infer<typeof SegmentSchema>;
