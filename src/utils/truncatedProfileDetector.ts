// KAN-90: detecta perfiles cuyo full_name quedó truncado por el bug ya corregido en
// POST /api/auth/exchange-token (antes: full_name = email.split('@')[0]). Función pura, sin
// acceso a red, para poder testearla sin Supabase — consumida por scripts/notify-truncated-profiles.ts.

export function isTruncatedFullName(fullName: string | null | undefined, email: string | null | undefined): boolean {
  if (!fullName || !email) return false;

  const localPart = email.split('@')[0]?.trim();
  if (!localPart) return false;

  return fullName.trim() === localPart;
}
