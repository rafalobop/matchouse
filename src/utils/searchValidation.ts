// KAN-38: validación del texto libre recibido en POST /api/search antes de pasarlo a la IA.
// Separada de src/index.ts porque ese archivo arranca el servidor completo al importarse
// (no se puede importar desde tests) — mismo patrón de módulo puro que matcher.ts/blindMatching.ts.

const MIN_LENGTH = 10;
const MAX_LENGTH = 1000;

// Caracteres de control (excepto \n y \r, comunes en texto pegado de WhatsApp/formularios).
const CONTROL_CHARS_REGEX = /[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/;

export function validateFreeSearchText(text: string): string | null {
  const trimmed = text.trim();

  if (trimmed.length < MIN_LENGTH) {
    return `El texto de búsqueda debe tener al menos ${MIN_LENGTH} caracteres.`;
  }

  if (trimmed.length > MAX_LENGTH) {
    return `El texto de búsqueda no puede superar los ${MAX_LENGTH} caracteres.`;
  }

  if (CONTROL_CHARS_REGEX.test(trimmed)) {
    return 'El texto de búsqueda contiene caracteres no permitidos.';
  }

  return null;
}
