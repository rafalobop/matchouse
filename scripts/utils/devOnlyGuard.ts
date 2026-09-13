// KAN-317: guard compartido por los scripts manuales de scripts/ (tocan infraestructura real —
// Supabase con Admin API, rate limiter distribuido) para que nunca puedan correr por accidente
// contra producción. Cada script lo invoca como primera línea de su ejecución, antes de tocar
// cualquier servicio real.
//
// assertDevOnly por sí solo solo mira NODE_ENV: no dice nada sobre a qué proyecto Supabase
// apunta SUPABASE_URL (dev/staging/prod pueden compartir NODE_ENV=development localmente). Por
// eso, además de la guarda de NODE_ENV, loguea explícitamente el SUPABASE_URL de destino y exige
// que el operador confirme ese proyecto a mano vía CONFIRM_SUPABASE_TARGET antes de mutar datos.
export function assertDevOnly(scriptName: string): void {
  if (process.env.NODE_ENV === 'production') {
    console.error(
      `⚠️  ADVERTENCIA: "${scriptName}" es un script de desarrollo/diagnóstico y no debe correr en producción (NODE_ENV=production). Abortando.`
    );
    process.exit(1);
  }

  const targetUrl = process.env.SUPABASE_URL ?? '(no configurado)';
  console.log(`🎯 "${scriptName}" va a mutar datos reales contra SUPABASE_URL=${targetUrl}`);

  if (process.env.CONFIRM_SUPABASE_TARGET !== targetUrl) {
    console.error(
      `⚠️  ADVERTENCIA: "${scriptName}" requiere confirmación explícita del proyecto de destino antes de mutar datos.\n` +
        `   Volvé a correrlo con CONFIRM_SUPABASE_TARGET="${targetUrl}" (el valor exacto de SUPABASE_URL) para confirmar que es el proyecto correcto.\n` +
        `   Abortando.`
    );
    process.exit(1);
  }
}
