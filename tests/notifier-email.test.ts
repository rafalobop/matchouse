import test from 'node:test';
import assert from 'node:assert';
import {
  buildEmailHtml,
  buildPropertyRowHtml,
  buildWhatsAppMessage,
  buildBlindMatchEmailHtml,
  buildBlindMatchPropertyRowHtml,
  sendBlindMatchEmailFallback,
  groupMatchesByTenant,
  groupMatchesByWhatsAppGroup,
  sendConsolidatedEmailNotifications,
  startEmailNotificationService,
  __setResendClientForTests
} from '../src/services/notifier-email';

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

// KAN-48: matches del matching ciego (POST /api/search, src/index.ts) tienen otra forma que los
// del match_queue legacy de WhatsApp usados más arriba en este archivo.
function sampleBlindMatch(overrides: Partial<any> = {}) {
  return {
    tenant_id: 'tenant-b',
    score: 90,
    property: {
      domicilio: 'Av. Alem 500',
      pisoLote: '2 A',
      precio: 150000,
      moneda: 'ARS',
      dormitorios: 2,
      caracteristicas: 'Pileta',
      operacion: 'venta',
      tipo_propiedad: 'departamento'
    },
    ...overrides
  };
}

function makeProfileClient(options: { email?: string | null } = {}) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    single: () => Promise.resolve({ data: options.email !== undefined ? { email: options.email } : null, error: null })
  };
  return { from: () => builder };
}

test('Notifier Email - buildBlindMatchPropertyRowHtml incluye domicilio, piso/lote, moneda y precio del match ciego', () => {
  const html = buildBlindMatchPropertyRowHtml(sampleBlindMatch());
  assert.ok(html.includes('Av. Alem 500'), 'Debe incluir el domicilio.');
  assert.ok(html.includes('2 A'), 'Debe incluir piso/lote entre paréntesis.');
  assert.ok(html.includes('ARS'), 'Debe incluir la moneda.');
  assert.ok(html.includes('150000'), 'Debe incluir el precio.');
});

test('Notifier Email - buildBlindMatchEmailHtml consolida varios matches e incluye el texto de la búsqueda', () => {
  const matches = [
    sampleBlindMatch(),
    sampleBlindMatch({ property: { ...sampleBlindMatch().property, domicilio: 'Mendoza 123' } })
  ];
  const html = buildBlindMatchEmailHtml('Busco depto 2 dormitorios en alquiler', matches);

  assert.ok(html.includes('Av. Alem 500'), 'Debe incluir la primera propiedad.');
  assert.ok(html.includes('Mendoza 123'), 'Debe incluir la segunda propiedad.');
  assert.ok(html.includes('Busco depto 2 dormitorios en alquiler'), 'Debe incluir el texto original de la búsqueda.');
});

test('Notifier Email - sendBlindMatchEmailFallback (KAN-48) devuelve false sin tocar la DB si no hay matches', async () => {
  const throwingClient = { from: () => { throw new Error('no debería consultarse la DB sin matches'); } };

  const result = await sendBlindMatchEmailFallback('tenant-1', 'Busco depto', [], throwingClient as any);

  assert.strictEqual(result, false);
});

test('Notifier Email - sendBlindMatchEmailFallback envía el email al address del profile y devuelve true', async () => {
  let sentTo: string | undefined;
  let sentSubject: string | undefined;
  __setResendClientForTests({
    emails: {
      send: async (opts: any) => {
        sentTo = opts.to;
        sentSubject = opts.subject;
        return { data: { id: 'mock-id' }, error: null };
      }
    }
  });

  const client = makeProfileClient({ email: 'agente@example.com' });
  const result = await sendBlindMatchEmailFallback('tenant-1', 'Busco depto', [sampleBlindMatch()], client as any);

  assert.strictEqual(result, true);
  assert.strictEqual(sentTo, 'agente@example.com');
  assert.ok(sentSubject?.includes('1 match'), 'El asunto debe reflejar la cantidad de matches.');
});

test('Notifier Email - sendBlindMatchEmailFallback devuelve false si el tenant no tiene email en profiles (sin intentar enviar)', async () => {
  let sendCalled = false;
  __setResendClientForTests({
    emails: { send: async () => { sendCalled = true; return { data: { id: 'x' }, error: null }; } }
  });

  const client = makeProfileClient({ email: null });
  const result = await sendBlindMatchEmailFallback('tenant-1', 'Busco depto', [sampleBlindMatch()], client as any);

  assert.strictEqual(result, false);
  assert.strictEqual(sendCalled, false, 'No debe intentar enviar si no hay email registrado.');
});

test('Notifier Email - sendBlindMatchEmailFallback devuelve false si Resend responde con error', async () => {
  __setResendClientForTests({
    emails: { send: async () => ({ data: null, error: { message: 'fallo simulado de Resend' } }) }
  });

  const client = makeProfileClient({ email: 'agente@example.com' });
  const result = await sendBlindMatchEmailFallback('tenant-1', 'Busco depto', [sampleBlindMatch()], client as any);

  assert.strictEqual(result, false);
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
