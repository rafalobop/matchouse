// KAN-48: orquestador chico que decide push vs. email para el evento "match encontrado" del
// matching ciego. El email es un canal de respaldo PERMANENTE (no reemplaza al push de
// KAN-44/45/46): se dispara solo cuando el tenant no tiene ninguna suscripción push activa, así
// los dos canales nunca se disparan para el mismo evento (AC de "no duplicaciones"). Recibe las
// tres acciones inyectadas (en vez de importar webPush.ts/notifier-email.ts directamente) para
// poder testear la lógica de decisión sin tocar Supabase/VAPID/Resend reales.
export interface NotifyMatchFoundDeps {
  hasActivePush: () => Promise<boolean>;
  sendPush: () => Promise<void>;
  sendEmailFallback: () => Promise<boolean>;
}

export async function notifyMatchFound(deps: NotifyMatchFoundDeps): Promise<'push' | 'email'> {
  const hasPush = await deps.hasActivePush();

  if (hasPush) {
    await deps.sendPush();
    return 'push';
  }

  await deps.sendEmailFallback();
  return 'email';
}
