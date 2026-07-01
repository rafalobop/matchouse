import test from 'node:test';
import assert from 'node:assert';
import { coordinator } from '../src/services/coordinator';
import { Property } from '../src/services/excel';

test('Coordinator Service - Debería guardar y recuperar catálogos en memoria por tenant', () => {
  const tenantId = 'test-tenant-coord';
  const properties: Property[] = [
    {
      address: 'Av. Alem 500',
      unit: '1A',
      price: 150000,
      currency: 'ARS',
      maintenance_fees: 10000,
      bedrooms: 2,
      features: 'Semipiso',
      contact_info: '123',
      zone_display_name: 'San Miguel de Tucumán',
      operation: 'venta',
      property_type: 'departamento',
      sheet_name: 'Ventas'
    }
  ];

  coordinator.setCatalog(tenantId, properties);
  const catalog = coordinator.getCatalog(tenantId);

  assert.strictEqual(catalog.length, 1, 'El catálogo debió guardarse con 1 elemento.');
  assert.strictEqual(catalog[0].address, 'Av. Alem 500', 'El domicilio del catálogo recuperado coincide.');
});
