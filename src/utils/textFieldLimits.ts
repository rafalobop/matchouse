// Los campos de texto libre de `properties` (alta/edición manual y filas de Excel) terminan
// interpolados enteros (vía JSON.stringify) dentro del prompt del Validador
// (<PROPIEDAD_SUGERIDA>, ver ai.ts) — sin tope, un texto arbitrariamente largo infla ese prompt
// sin control. Mismo criterio que MAX_LENGTH de searchValidation.ts, con topes por campo acordes
// a su uso real. Compartido entre propertiesController.ts (alta manual) y excel.ts (carga masiva)
// para que ambos caminos de escritura a `properties` apliquen el mismo límite.
export const FIELD_MAX_LENGTHS = {
  address: 300,
  floor: 50,
  unit: 50,
  block: 50,
  lot: 50,
  features: 2000,
  contact_info: 500
} as const;
