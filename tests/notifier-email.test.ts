import test from 'node:test';
import assert from 'node:assert';
import {
  buildEmailHtml,
  buildPropertyRowHtml,
  buildWhatsAppMessage,
  groupMatchesByTenant,
  groupMatchesByWhatsAppGroup,
  sendConsolidatedEmailNotifications,
  startEmailNotificationService,
  __setResendClientForTests
} from '../src/services/notifier-email';
import { validateConfig } from '../src/config/env';

const sampleProperty = {
  address: 'Av. Alem 500',
  floor: '2',
  unit: 'A',
  block: null,
  lot: null,
  price: 150000,
  currency: 'ARS',
  bedrooms: 2,
  operation: 'venta',
  property_type: 'departamento'
};

function sampleMatch(overrides: Partial<any> = {}) {
  return {
    id: 'match-1',
    tenant_id: 'tenant-1',
    whatsapp_group_name: 'Grupo Test',
    whatsapp_sender_name: 'Juan Perez',
    whatsapp_sender_phone: '5493815551234',
    raw_message_text: 'Busco depto 2 dormitorios',
    property: sampleProperty,
    ...overrides
  };
}

test('Notifier Email - expone las funciones esperadas', () => {
  assert.strictEqual(typeof sendConsolidatedEmailNotifications, 'function');
  assert.strictEqual(typeof startEmailNotificationService, 'function');
});

test('Notifier Email - buildWhatsAppMessage incluye domicilio y precio de la propiedad', () => {
  const message = buildWhatsAppMessage('Grupo Test', sampleProperty);
  assert.ok(message.includes('Av. Alem 500'), 'El mensaje debe incluir el domicilio.');
  assert.ok(message.includes('150000'), 'El mensaje debe incluir el precio.');
  assert.ok(message.includes('Grupo Test'), 'El mensaje debe incluir el nombre del grupo.');
});

test('Notifier Email - buildWhatsAppMessage personaliza con nombre del cliente y su pedido original', () => {
  const message = buildWhatsAppMessage('Grupo Test', sampleProperty, 'Juan Perez', 'Busco depto 2 dormitorios');
  assert.ok(message.startsWith('Hola Juan Perez!'), 'Debe saludar al cliente por su nombre.');
  assert.ok(message.includes('Busco depto 2 dormitorios'), 'Debe incluir el pedido original del cliente.');
  assert.ok(message.includes('Av. Alem 500'), 'Debe incluir el domicilio de la propiedad matcheada.');
});

test('Notifier Email - buildPropertyRowHtml arma el HTML con los datos de la propiedad y el link de click', () => {
  const html = buildPropertyRowHtml(sampleMatch());
  assert.ok(html.includes('Av. Alem 500'), 'Debe incluir el domicilio.');
  assert.ok(html.includes('ARS'), 'Debe incluir la moneda.');
  assert.ok(html.includes('150000'), 'Debe incluir el precio.');
  assert.ok(html.includes('/api/notifications/email/click/match-1'), 'Debe incluir el link de click trackeado con el id del match.');
});

test('Notifier Email - buildEmailHtml consolida varias propiedades y agrega el pixel de apertura', () => {
  const matches = [
    sampleMatch({ id: 'match-1' }),
    sampleMatch({ id: 'match-2', property: { ...sampleProperty, address: 'Mendoza 123' } })
  ];
  const html = buildEmailHtml('Grupo Test', 'Busco depto 2 dormitorios', 'Juan Perez', matches);

  assert.ok(html.includes('Av. Alem 500'), 'Debe incluir la primera propiedad.');
  assert.ok(html.includes('Mendoza 123'), 'Debe incluir la segunda propiedad.');
  assert.ok(html.includes('/api/notifications/email/pixel/match-1.gif'), 'Debe incluir el pixel de apertura asociado al primer match del lote.');
});

test('Notifier Email - groupMatchesByTenant agrupa correctamente por tenant_id', () => {
  const matches = [
    sampleMatch({ id: 'm1', tenant_id: 'tenant-a' }),
    sampleMatch({ id: 'm2', tenant_id: 'tenant-b' }),
    sampleMatch({ id: 'm3', tenant_id: 'tenant-a' })
  ];
  const grouped = groupMatchesByTenant(matches);

  assert.strictEqual(grouped.size, 2, 'Debe haber 2 tenants distintos.');
  assert.strictEqual(grouped.get('tenant-a')!.length, 2, 'tenant-a debe tener 2 matches.');
  assert.strictEqual(grouped.get('tenant-b')!.length, 1, 'tenant-b debe tener 1 match.');
});

test('Notifier Email - groupMatchesByWhatsAppGroup agrupa correctamente por grupo de WhatsApp', () => {
  const matches = [
    sampleMatch({ id: 'm1', whatsapp_group_name: 'Grupo A' }),
    sampleMatch({ id: 'm2', whatsapp_group_name: 'Grupo B' }),
    sampleMatch({ id: 'm3', whatsapp_group_name: 'Grupo A' })
  ];
  const grouped = groupMatchesByWhatsAppGroup(matches);

  assert.strictEqual(grouped.size, 2, 'Debe haber 2 grupos distintos.');
  assert.strictEqual(grouped.get('Grupo A')!.length, 2, 'Grupo A debe tener 2 matches.');
});

test('Notifier Email - NOTIFICATION_CHANNEL respeta el flag de canal (default email, explícito whatsapp)', () => {
  const originalValue = process.env.NOTIFICATION_CHANNEL;
  try {
    delete process.env.NOTIFICATION_CHANNEL;
    const defaultConfig = validateConfig();
    assert.strictEqual(defaultConfig.notificationChannel, 'email', 'Sin la variable definida, el canal primario debe ser email.');

    process.env.NOTIFICATION_CHANNEL = 'whatsapp';
    const whatsappConfig = validateConfig();
    assert.strictEqual(whatsappConfig.notificationChannel, 'whatsapp', 'Con NOTIFICATION_CHANNEL=whatsapp, el canal debe ser whatsapp.');
  } finally {
    if (originalValue === undefined) {
      delete process.env.NOTIFICATION_CHANNEL;
    } else {
      process.env.NOTIFICATION_CHANNEL = originalValue;
    }
  }
});

test('Notifier Email - __setResendClientForTests permite inyectar un mock (nunca se manda mail real en el test suite)', () => {
  let sendCalled = false;
  __setResendClientForTests({
    emails: {
      send: async () => {
        sendCalled = true;
        return { data: { id: 'mock-id' }, error: null };
      }
    }
  });
  assert.strictEqual(sendCalled, false, 'Inyectar el mock no debe disparar un envío por sí solo.');
});
