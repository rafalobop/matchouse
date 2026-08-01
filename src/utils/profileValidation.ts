// KAN-64: validacion del formulario de perfil que un agente completa despues del magic link
// (nombre, apellido, telefono, inmobiliaria, ciudad). Modulo puro separado de src/index.ts por
// el mismo motivo que searchValidation.ts / activeSearches.ts (ese archivo arranca el servidor
// completo al importarse, no se puede importar desde tests).
// KAN-93: `country` ya no es parte de este input — el negocio fija Argentina como unico pais
// habilitado, se hardcodea en src/index.ts#POST /api/profile en vez de validarse acá.

export interface ProfileInput {
  first_name?: unknown;
  last_name?: unknown;
  phone_number?: unknown;
  agency_name?: unknown;
  city?: unknown;
}

const MAX_PHONE_LENGTH = 20;
const MAX_TEXT_FIELD_LENGTH = 150;
// Digitos, espacios y los simbolos comunes de un telefono de contacto (+, -, parentesis).
const PHONE_ALLOWED_CHARS_REGEX = /^[\d+\-() ]+$/;

// KAN-90: reglas de formato para nombre/apellido (documentadas también en README.md). Mínimo 2
// caracteres (evita iniciales sueltas tipo "J"), máximo 100 (más chico que MAX_TEXT_FIELD_LENGTH
// genérico, un nombre real no necesita 150 caracteres). Charset: letras (incluye acentos/ñ vía la
// propiedad Unicode \p{L}, no solo ASCII), espacios, guiones y apóstrofes — cubre nombres
// compuestos ("María José"), apellidos con guión ("Pérez-García") y apóstrofes ("O'Connor"); sin
// dígitos ni el resto de símbolos, que no son parte de un nombre real.
const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 100;
const NAME_ALLOWED_CHARS_REGEX = /^[\p{L}\s'-]+$/u;

function validateRequiredText(value: unknown, label: string, maxLength: number): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return `El campo ${label} es requerido.`;
  }
  if (value.trim().length > maxLength) {
    return `El campo ${label} no puede superar los ${maxLength} caracteres.`;
  }
  return null;
}

function validateName(value: unknown, label: string): string | null {
  const requiredError = validateRequiredText(value, label, MAX_NAME_LENGTH);
  if (requiredError) return requiredError;

  const trimmed = (value as string).trim();
  if (trimmed.length < MIN_NAME_LENGTH) {
    return `El campo ${label} debe tener al menos ${MIN_NAME_LENGTH} caracteres.`;
  }
  if (!NAME_ALLOWED_CHARS_REGEX.test(trimmed)) {
    return `El campo ${label} solo puede contener letras, espacios, guiones y apóstrofes.`;
  }
  return null;
}

export function validateProfileInput(input: ProfileInput): string | null {
  const firstNameError = validateName(input.first_name, 'first_name');
  if (firstNameError) return firstNameError;

  const lastNameError = validateName(input.last_name, 'last_name');
  if (lastNameError) return lastNameError;

  const phoneError = validateRequiredText(input.phone_number, 'phone_number', MAX_PHONE_LENGTH);
  if (phoneError) return phoneError;
  if (!PHONE_ALLOWED_CHARS_REGEX.test((input.phone_number as string).trim())) {
    return 'El campo phone_number contiene caracteres no permitidos.';
  }

  const agencyError = validateRequiredText(input.agency_name, 'agency_name', MAX_TEXT_FIELD_LENGTH);
  if (agencyError) return agencyError;

  const cityError = validateRequiredText(input.city, 'city', MAX_TEXT_FIELD_LENGTH);
  if (cityError) return cityError;

  return null;
}
