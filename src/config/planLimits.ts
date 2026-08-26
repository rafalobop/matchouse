// Fase 1 pre-lanzamiento (brokaza-frontend/Next_Steps.md): límites de uso por plan. Un solo tier
// activo hoy (FREE) — sumar un tier pago más adelante es agregar una entrada acá (+ el valor
// correspondiente en el CHECK de profiles.plan, ver docs/evolucion_proyecto/
// add_profiles_plan_2026-08-24.sql), sin tocar la lógica de enforcement en services/planLimits.ts.
export type PlanTier = 'FREE';

export interface PlanLimits {
  maxProperties: number;
  maxSearchesPerMonth: number;
}

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  FREE: { maxProperties: 100, maxSearchesPerMonth: 10 }
};
