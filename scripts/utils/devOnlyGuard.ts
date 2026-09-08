// KAN-317: guard compartido por los scripts manuales de scripts/ (tocan infraestructura real —
// Supabase con Admin API, rate limiter distribuido) para que nunca puedan correr por accidente
// contra producción. Cada script lo invoca como primera línea de su ejecución, antes de tocar
// cualquier servicio real.
export function assertDevOnly(scriptName: string): void {
  if (process.env.NODE_ENV === 'production') {
    console.error(
      `⚠️  ADVERTENCIA: "${scriptName}" es un script de desarrollo/diagnóstico y no debe correr en producción (NODE_ENV=production). Abortando.`
    );
    process.exit(1);
  }
}
