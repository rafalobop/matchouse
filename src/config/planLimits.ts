// Fase 1 pre-lanzamiento (brokaza-frontend/Next_Steps.md): límites de uso por plan. Un solo tier
// activo hoy (FREE) — sumar un tier pago más adelante es agregar una entrada acá (+ el valor
// correspondiente en el CHECK de profiles.plan, ver docs/evolucion_proyecto/
// add_profiles_plan_2026-08-24.sql), sin tocar la lógica de enforcement en services/planLimits.ts.
export type PlanTier = 'FREE';

export interface PlanLimits {
  maxProperties: number;
  maxSearchesPerMonth: number;
  // Cantidad de colaboradores que un dueño de agencia puede invitar (KAN-306,
  // `adminPanelController.ts#inviteCollaborator`). Placeholder documentado (2026-09-04, decisión
  // de negocio): sin registro limitado de corredores/dueños, el único límite de usuarios va a ser
  // este — cuántos colaboradores puede sumar cada dueño bajo su agencia, según su plan pago. Sin
  // enforcement todavía (`inviteCollaborator` no lee este valor) porque los planes pagos no están
  // implementados; el valor de FREE de abajo es un techo generoso solo para no bloquear el uso
  // real mientras tanto, no una decisión de producto final.
  maxCollaborators: number;
}

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  FREE: { maxProperties: 100, maxSearchesPerMonth: 10, maxCollaborators: 20 }
};
