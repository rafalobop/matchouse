/**
 * KAN-90 (AC4): notifica a los usuarios cuyo `profiles.full_name` quedó truncado por el bug ya
 * corregido en `POST /api/auth/exchange-token` (antes: `full_name = email.split('@')[0]`, ej.
 * "juan.perez" en vez de "Juan Pérez"). Para cada perfil afectado: envía un email (Resend) pidiendo
 * que actualice su nombre, y resetea `profile_completed = false` para que el formulario de perfil
 * (ahora con los campos Nombre/Apellido) se le vuelva a mostrar apenas inicie sesión — es el
 * mecanismo real que fuerza la corrección, el email es solo el aviso.
 *
 * NO se ejecuta automáticamente en ningún flujo de la app — hace falta correrlo a mano:
 *   npx ts-node scripts/notify-truncated-profiles.ts --dry-run   (solo lista los afectados)
 *   npx ts-node scripts/notify-truncated-profiles.ts             (manda los emails reales y muta profile_completed)
 *
 * Reproducible (no se borra al terminar el ticket, a diferencia de un script desechable de
 * verificación) — útil para volver a correr en otro ambiente o si reaparecen filas con el mismo
 * patrón por otra causa.
 *
 * Idempotente entre corridas: cada perfil notificado queda marcado con
 * `truncated_name_notified_at`, así que corridas posteriores (antes de que el usuario corrija su
 * perfil) no le reenvían el email.
 */
import { Resend } from 'resend';
import { supabase } from '../src/services/supabase';
import { config } from '../src/config/env';
import { logger } from '../src/services/logger';
import { isTruncatedFullName } from '../src/utils/truncatedProfileDetector';

const FROM_ADDRESS = 'Brokaza <hola@brokaza.com>';

interface AffectedProfile {
  id: string;
  email: string;
  full_name: string;
}

async function findAffectedProfiles(): Promise<AffectedProfile[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name')
    .is('truncated_name_notified_at', null);
  if (error) {
    throw new Error(`No se pudo leer profiles: ${error.message}`);
  }
  return (data ?? []).filter((p: any) => isTruncatedFullName(p.full_name, p.email));
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const affected = await findAffectedProfiles();
  console.log(`Perfiles afectados (full_name truncado del email): ${affected.length}`);
  affected.forEach((p) => console.log(`  - ${p.email} (id=${p.id}, full_name actual="${p.full_name}")`));

  if (affected.length === 0) {
    console.log('Nada para hacer.');
    return;
  }

  if (dryRun) {
    console.log('\n--dry-run: no se envían emails ni se modifica profile_completed. Correr sin el flag para aplicar.');
    return;
  }

  if (!config.resendApiKey) {
    throw new Error('Falta SENDER_API_KEY (Resend) para enviar las notificaciones.');
  }
  const resend = new Resend(config.resendApiKey);

  let sent = 0;
  let failed = 0;

  for (const profile of affected) {
    try {
      const emailResult = await resend.emails.send({
        from: FROM_ADDRESS,
        to: profile.email,
        subject: 'Actualizá tu nombre en Brokaza',
        html: `<p>Hola,</p>` +
          `<p>Notamos que tu perfil en Brokaza quedó con un nombre incompleto (generado automáticamente a partir de tu email, no el tuyo real).</p>` +
          `<p>La próxima vez que inicies sesión te vamos a pedir que completes tu nombre y apellido reales antes de seguir usando el dashboard.</p>` +
          `<p>Gracias,<br/>El equipo de Brokaza</p>`
      });
      if ((emailResult as any)?.error) {
        throw new Error((emailResult as any).error.message || 'Error desconocido de Resend');
      }

      const { error: updateError } = await supabase
        .from('profiles')
        .update({ profile_completed: false, truncated_name_notified_at: new Date().toISOString() })
        .eq('id', profile.id);

      if (updateError) {
        throw new Error(`No se pudo resetear profile_completed: ${updateError.message}`);
      }

      sent++;
    } catch (err: any) {
      logger.error({ profileId: profile.id, email: profile.email, error: err.message || err }, '[KAN-90] Error al notificar/resetear un perfil truncado');
      failed++;
    }
  }

  console.log(`\nNotificados y reseteados: ${sent}. Fallidos: ${failed}.`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
