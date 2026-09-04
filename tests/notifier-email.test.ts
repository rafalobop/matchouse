import test from 'node:test';
import assert from 'node:assert';
import {
  buildEmailHtml,
  buildPropertyRowHtml,
  buildWhatsAppMessage,
  buildBlindMatchPropertyRowHtml,
  buildIncomingMatchEmailHtml,
  sendIncomingMatchEmailFallback,
  groupMatchesByTenant,
  groupMatchesByWhatsAppGroup,
  buildMagicLinkFirstTimeEmailHtml,
  buildMagicLinkReturningEmailHtml,
  buildAdminMagicLinkEmailHtml,
  sendMagicLinkEmail,
  sendAdminMagicLinkEmail,
  buildReengagementEmailHtml,
  sendReengagementEmail,
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

// KAN-78: aviso al dueño de la propiedad matcheada de que un agente la buscó — único lado que se
// notifica (decisión de producto, 2026-08-21) — a diferencia del push, el email SÍ incluye el
// contacto completo del buscador porque es un canal privado 1:1 con el dueño de la propiedad.
const sampleSearcherSnapshot = { full_name: 'Juan Perez', phone_number: '5493815551234', agency_name: 'Inmobiliaria Test' };

test('Notifier Email - buildIncomingMatchEmailHtml incluye el contacto del buscador y el texto de la búsqueda', () => {
  const html = buildIncomingMatchEmailHtml(sampleSearcherSnapshot, 'Busco depto 2 dormitorios en alquiler', [sampleBlindMatch()]);

  assert.ok(html.includes('Juan Perez'), 'Debe incluir el nombre del buscador.');
  assert.ok(html.includes('Inmobiliaria Test'), 'Debe incluir la inmobiliaria del buscador.');
  assert.ok(html.includes('5493815551234'), 'Debe incluir el teléfono del buscador.');
  assert.ok(html.includes('Busco depto 2 dormitorios en alquiler'), 'Debe incluir el texto original de la búsqueda.');
  assert.ok(html.includes('Av. Alem 500'), 'Debe incluir la propiedad matcheada.');
});

test('Notifier Email - buildIncomingMatchEmailHtml no incluye ningún dato de contacto si el snapshot está vacío', () => {
  const html = buildIncomingMatchEmailHtml({ full_name: null, phone_number: null, agency_name: null }, 'Busco depto', [sampleBlindMatch()]);
  assert.ok(html.includes('Sin datos de contacto disponibles'));
});

test('Notifier Email - sendIncomingMatchEmailFallback devuelve false sin tocar la DB si no hay matches', async () => {
  const throwingClient = { from: () => { throw new Error('no debería consultarse la DB sin matches'); } };
  const result = await sendIncomingMatchEmailFallback('owner-1', sampleSearcherSnapshot, 'Busco depto', [], throwingClient as any);
  assert.strictEqual(result, false);
});

test('Notifier Email - sendIncomingMatchEmailFallback envía el email al address del dueño de la propiedad y devuelve true', async () => {
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

  const client = makeProfileClient({ email: 'dueno@example.com' });
  const result = await sendIncomingMatchEmailFallback('owner-1', sampleSearcherSnapshot, 'Busco depto', [sampleBlindMatch()], client as any);

  assert.strictEqual(result, true);
  assert.strictEqual(sentTo, 'dueno@example.com');
  assert.ok(sentSubject?.includes('1 de tus propiedades'), 'El asunto debe reflejar la cantidad de propiedades.');
});

test('Notifier Email - sendIncomingMatchEmailFallback devuelve false si el dueño no tiene email en profiles', async () => {
  let sendCalled = false;
  __setResendClientForTests({
    emails: { send: async () => { sendCalled = true; return { data: { id: 'x' }, error: null }; } }
  });

  const client = makeProfileClient({ email: null });
  const result = await sendIncomingMatchEmailFallback('owner-1', sampleSearcherSnapshot, 'Busco depto', [sampleBlindMatch()], client as any);

  assert.strictEqual(result, false);
  assert.strictEqual(sendCalled, false, 'No debe intentar enviar si no hay email registrado.');
});

// Magic link (2026-08-22) — Supabase ya no manda este email (su template único no puede
// diferenciar tenant/admin ni primera vez/ya registrado), ver src/routes/auth.ts.
test('Notifier Email - buildMagicLinkFirstTimeEmailHtml incluye el link y el logo, con copy de bienvenida', () => {
  const html = buildMagicLinkFirstTimeEmailHtml('https://example.supabase.co/auth/v1/verify?token=abc');

  assert.ok(html.includes('https://example.supabase.co/auth/v1/verify?token=abc'), 'Debe incluir el link de acceso.');
  assert.ok(html.includes('logo_brokaza.png'), 'Debe incluir el logo de marca.');
  assert.ok(html.includes('¡Bienvenido a Brokaza!'), 'Debe usar el copy de bienvenida de primera vez.');
});

test('Notifier Email - buildMagicLinkReturningEmailHtml incluye el link y el logo, con copy distinto al de primera vez', () => {
  const html = buildMagicLinkReturningEmailHtml('https://example.supabase.co/auth/v1/verify?token=xyz');

  assert.ok(html.includes('https://example.supabase.co/auth/v1/verify?token=xyz'), 'Debe incluir el link de acceso.');
  assert.ok(html.includes('logo_brokaza.png'), 'Debe incluir el logo de marca.');
  assert.ok(html.includes('¡Hola de nuevo!'), 'Debe usar el copy de bienvenida de regreso.');
  assert.ok(!html.includes('¡Bienvenido a Brokaza!'), 'No debe compartir el copy del template de primera vez.');
});

test('Notifier Email - buildAdminMagicLinkEmailHtml incluye el link, el logo y el copy de administrador', () => {
  const html = buildAdminMagicLinkEmailHtml('https://example.supabase.co/auth/v1/verify?token=admin1');

  assert.ok(html.includes('https://example.supabase.co/auth/v1/verify?token=admin1'), 'Debe incluir el link de acceso.');
  assert.ok(html.includes('logo_brokaza.png'), 'Debe incluir el logo de marca.');
  assert.ok(html.includes('Hola, administrador'), 'Debe usar el copy de administrador.');
});

test('Notifier Email - sendMagicLinkEmail (primera vez) usa el template y el subject de bienvenida', async () => {
  let sentTo: string | undefined;
  let sentSubject: string | undefined;
  let sentHtml: string | undefined;
  __setResendClientForTests({
    emails: {
      send: async (opts: any) => {
        sentTo = opts.to;
        sentSubject = opts.subject;
        sentHtml = opts.html;
        return { data: { id: 'mock-id' }, error: null };
      }
    }
  });

  const result = await sendMagicLinkEmail('nuevo@example.com', 'https://link.example/1', true);

  assert.strictEqual(result, true);
  assert.strictEqual(sentTo, 'nuevo@example.com');
  assert.ok(sentSubject?.toLowerCase().includes('bienvenido'), 'El asunto debe reflejar que es primera vez.');
  assert.ok(sentHtml?.includes('https://link.example/1'), 'El HTML debe incluir el link generado.');
});

test('Notifier Email - sendMagicLinkEmail (ya registrado) usa el template y el subject de regreso', async () => {
  let sentSubject: string | undefined;
  let sentHtml: string | undefined;
  __setResendClientForTests({
    emails: {
      send: async (opts: any) => {
        sentSubject = opts.subject;
        sentHtml = opts.html;
        return { data: { id: 'mock-id' }, error: null };
      }
    }
  });

  const result = await sendMagicLinkEmail('agente@example.com', 'https://link.example/2', false);

  assert.strictEqual(result, true);
  assert.ok(!sentSubject?.toLowerCase().includes('bienvenido'), 'El asunto de un tenant ya registrado no debe usar el copy de bienvenida.');
  assert.ok(sentHtml?.includes('¡Hola de nuevo!'), 'Debe usar el template de regreso, no el de primera vez.');
});

test('Notifier Email - sendMagicLinkEmail devuelve false si Resend responde con error', async () => {
  __setResendClientForTests({
    emails: { send: async () => ({ data: null, error: { message: 'fallo simulado de Resend' } }) }
  });

  const result = await sendMagicLinkEmail('agente@example.com', 'https://link.example/3', false);

  assert.strictEqual(result, false);
});

test('Notifier Email - sendAdminMagicLinkEmail manda al email del admin con el subject y template correctos', async () => {
  let sentTo: string | undefined;
  let sentSubject: string | undefined;
  let sentHtml: string | undefined;
  __setResendClientForTests({
    emails: {
      send: async (opts: any) => {
        sentTo = opts.to;
        sentSubject = opts.subject;
        sentHtml = opts.html;
        return { data: { id: 'mock-id' }, error: null };
      }
    }
  });

  const result = await sendAdminMagicLinkEmail('admin@brokaza.com', 'https://link.example/admin');

  assert.strictEqual(result, true);
  assert.strictEqual(sentTo, 'admin@brokaza.com');
  assert.ok(sentSubject?.toLowerCase().includes('admin'), 'El asunto debe mencionar el panel admin.');
  assert.ok(sentHtml?.includes('Hola, administrador'), 'Debe usar el template de admin.');
});

test('Notifier Email - sendAdminMagicLinkEmail devuelve false si Resend responde con error', async () => {
  __setResendClientForTests({
    emails: { send: async () => ({ data: null, error: { message: 'fallo simulado de Resend' } }) }
  });

  const result = await sendAdminMagicLinkEmail('admin@brokaza.com', 'https://link.example/admin-err');

  assert.strictEqual(result, false);
});

// KAN-58: aviso de reenganche ("¿la renovás?") — canal de respaldo del push para active_searches
// vencidas (KAN-41) sin ningún match persistido en blind_matches (ver src/services/reengagement.ts).
test('Notifier Email - buildReengagementEmailHtml incluye el texto original de la búsqueda y la pregunta de reenganche', () => {
  const html = buildReengagementEmailHtml('Busco depto 2 dormitorios en alquiler');

  assert.ok(html.includes('Busco depto 2 dormitorios en alquiler'), 'Debe incluir el texto original de la búsqueda.');
  assert.ok(html.includes('¿La renovás?'), 'Debe usar el copy de reenganche.');
});

test('Notifier Email - buildReengagementEmailHtml trunca textos de búsqueda muy largos', () => {
  const longText = 'a'.repeat(200);
  const html = buildReengagementEmailHtml(longText);

  assert.ok(!html.includes(longText), 'No debe incluir el texto completo sin truncar.');
  assert.ok(html.includes('...'), 'Debe truncar con puntos suspensivos.');
});

test('Notifier Email - sendReengagementEmail envía al email del tenant y devuelve true', async () => {
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
  const result = await sendReengagementEmail('tenant-1', 'Busco depto', client as any);

  assert.strictEqual(result, true);
  assert.strictEqual(sentTo, 'agente@example.com');
  assert.ok(sentSubject?.toLowerCase().includes('renovás'), 'El asunto debe reflejar el copy de reenganche.');
});

test('Notifier Email - sendReengagementEmail devuelve false si el tenant no tiene email en profiles', async () => {
  let sendCalled = false;
  __setResendClientForTests({
    emails: { send: async () => { sendCalled = true; return { data: { id: 'x' }, error: null }; } }
  });

  const client = makeProfileClient({ email: null });
  const result = await sendReengagementEmail('tenant-1', 'Busco depto', client as any);

  assert.strictEqual(result, false);
  assert.strictEqual(sendCalled, false, 'No debe intentar enviar si no hay email registrado.');
});

test('Notifier Email - sendReengagementEmail devuelve false si Resend responde con error', async () => {
  __setResendClientForTests({
    emails: { send: async () => ({ data: null, error: { message: 'fallo simulado de Resend' } }) }
  });

  const client = makeProfileClient({ email: 'agente@example.com' });
  const result = await sendReengagementEmail('tenant-1', 'Busco depto', client as any);

  assert.strictEqual(result, false);
});
