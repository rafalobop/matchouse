// KAN-64: validacion del formulario de perfil que un agente completa despues del magic link
// (telefono, inmobiliaria, ciudad, pais). Modulo puro separado de src/index.ts por el mismo
// motivo que searchValidation.ts / activeSearches.ts (ese archivo arranca el servidor completo
// al importarse, no se puede importar desde tests).

export interface ProfileInput {
  phone_number?: unknown;
  agency_name?: unknown;
  city?: unknown;
  country?: unknown;
}

const MAX_PHONE_LENGTH = 20;
const MAX_TEXT_FIELD_LENGTH = 150;
// Digitos, espacios y los simbolos comunes de un telefono de contacto (+, -, parentesis).
const PHONE_ALLOWED_CHARS_REGEX = /^[\d+\-() ]+$/;

function validateRequiredText(value: unknown, label: string, maxLength: number): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return `El campo ${label} es requerido.`;
  }
  if (value.trim().length > maxLength) {
    return `El campo ${label} no puede superar los ${maxLength} caracteres.`;
  }
  return null;
}

export function validateProfileInput(input: ProfileInput): string | null {
  const phoneError = validateRequiredText(input.phone_number, 'phone_number', MAX_PHONE_LENGTH);
  if (phoneError) return phoneError;
  if (!PHONE_ALLOWED_CHARS_REGEX.test((input.phone_number as string).trim())) {
    return 'El campo phone_number contiene caracteres no permitidos.';
  }

  const agencyError = validateRequiredText(input.agency_name, 'agency_name', MAX_TEXT_FIELD_LENGTH);
  if (agencyError) return agencyError;

  const cityError = validateRequiredText(input.city, 'city', MAX_TEXT_FIELD_LENGTH);
  if (cityError) return cityError;

  const countryError = validateRequiredText(input.country, 'country', MAX_TEXT_FIELD_LENGTH);
  if (countryError) return countryError;

  return null;
}
