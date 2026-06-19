import test from 'node:test';
import assert from 'node:assert';
import { coordinator } from '../src/services/coordinator';
import { Property } from '../src/services/excel';

test('Coordinator Service - Debería guardar y recuperar catálogos en memoria por tenant', () => {
  const tenantId = 'test-tenant-coord';
  const properties: Property[] = [
    {
      domicilio: 'Av. Alem 500',
      pisoLote: '1A',
      precio: 150000,
      moneda: 'ARS',
      expensas: 10000,
      dormitorios: 2,
      caracteristicas: 'Semipiso',
      contacto: '123',
      zona: 'San Miguel de Tucumán',
      operacion: 'venta',
      tipo_propiedad: 'departamento',
      sheetName: 'Ventas'
    }
  ];

  coordinator.setCatalog(tenantId, properties);
  const catalog = coordinator.getCatalog(tenantId);

  assert.strictEqual(catalog.length, 1, 'El catálogo debió guardarse con 1 elemento.');
  assert.strictEqual(catalog[0].domicilio, 'Av. Alem 500', 'El domicilio del catálogo recuperado coincide.');
});
