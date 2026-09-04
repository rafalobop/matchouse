import test from 'node:test';
import assert from 'node:assert';
import {
  parsePadronHtml,
  fetchPadronHtml,
  syncLicensedAgents,
  resolveLicenseValidationStatus
} from '../src/services/licenseRegistry';

// KAN-306: fixture con la misma estructura real del padrón (confirmada por inspección directa de
// https://ccit.com.ar/padron/, plugin "Ninja Tables" de WordPress) — <thead> con las 7 columnas
// (INMOBILIARIA, MAT, CORREDOR - INMOBILIARIO, C.U.I.T., DIRECCION, TELEFONOS, MAIL) y <tbody>
// con una fila por matriculado. Incluye una entidad HTML (&amp;) y una fila de encabezado
// intercalada, dos casos reales observados en la página.
const PADRON_FIXTURE_HTML = `
<table class="ninja_table">
  <thead>
    <tr class="footable-header">
      <th>INMOBILIARIA</th><th>MAT</th><th>CORREDOR - INMOBILIARIO</th><th>C.U.I.T.</th><th>DIRECCION</th><th>TELEFONOS</th><th>MAIL</th>
    </tr>
  </thead>
  <tbody>
    <tr data-row_id="1">
      <td>LEON &amp; MACIAS INMOBILIARIA</td><td>001</td><td>MACIAS OSCAR</td><td>20-08067986-7</td><td>CRISOSTOMO ALVAREZ 566</td><td>4311870</td><td>oscar@example.com</td>
    </tr>
    <tr data-row_id="2">
      <td>VERTICE NEGOCIOS INMOBILIARIOS</td><td>350</td><td>ACUÑA PABLO</td><td>20-27575487-1</td><td>24 DE SETIEMBRE 1085</td><td>381-6422310</td><td>pablo@example.com</td>
    </tr>
  </tbody>
</table>
`;

test('licenseRegistry - parsePadronHtml extrae los registros con el orden de columnas real', () => {
  const records = parsePadronHtml(PADRON_FIXTURE_HTML);

  assert.strictEqual(records.length, 2);
  assert.deepStrictEqual(records[0], {
    licenseNumber: '001',
    agencyName: 'LEON & MACIAS INMOBILIARIA',
    brokerName: 'MACIAS OSCAR',
    cuit: '20-08067986-7',
    address: 'CRISOSTOMO ALVAREZ 566',
    phones: '4311870',
    email: 'oscar@example.com'
  });
  assert.strictEqual(records[1].licenseNumber, '350');
});

test('licenseRegistry - parsePadronHtml descarta la fila de encabezado (MAT no numérico)', () => {
  const records = parsePadronHtml(PADRON_FIXTURE_HTML);
  assert.ok(!records.some((r) => r.agencyName === 'INMOBILIARIA'), 'la fila del <thead> no debe colarse como un registro.');
});

test('licenseRegistry - parsePadronHtml devuelve array vacío ante HTML sin filas válidas', () => {
  assert.deepStrictEqual(parsePadronHtml('<html><body>sin tabla</body></html>'), []);
});

test('licenseRegistry - parsePadronHtml decodifica entidades HTML (&amp;)', () => {
  const records = parsePadronHtml(PADRON_FIXTURE_HTML);
  assert.strictEqual(records[0].agencyName, 'LEON & MACIAS INMOBILIARIA');
});

function makeFakeFetch(html: string, ok = true, status = 200) {
  return (async () => ({ ok, status, text: async () => html })) as unknown as typeof fetch;
}

test('licenseRegistry - fetchPadronHtml devuelve el texto de la respuesta cuando ok=true', async () => {
  const html = await fetchPadronHtml(makeFakeFetch(PADRON_FIXTURE_HTML));
  assert.strictEqual(html, PADRON_FIXTURE_HTML);
});

test('licenseRegistry - fetchPadronHtml lanza si la respuesta no es ok', async () => {
  await assert.rejects(() => fetchPadronHtml(makeFakeFetch('', false, 503)));
});

// Mock mínimo de un query builder de Supabase encadenable (upsert/delete/lt), mismo estilo que
// searchExpiration.test.ts.
function makeMockSyncClient(options: { upsertError?: any; deleteError?: any } = {}) {
  const calls: { method: string; args: any[] }[] = [];
  const builder: any = {
    upsert: (...args: any[]) => {
      calls.push({ method: 'upsert', args });
      return Promise.resolve({ error: options.upsertError ?? null });
    },
    delete: (...args: any[]) => { calls.push({ method: 'delete', args }); return builder; },
    lt: (...args: any[]) => {
      calls.push({ method: 'lt', args });
      return Promise.resolve({ error: options.deleteError ?? null });
    }
  };
  return { from: (table: string) => { calls.push({ method: 'from', args: [table] }); return builder; }, calls };
}

test('licenseRegistry - syncLicensedAgents hace upsert por license_number y borra las filas viejas', async () => {
  const mockClient = makeMockSyncClient();
  const result = await syncLicensedAgents(mockClient as any, makeFakeFetch(PADRON_FIXTURE_HTML));

  assert.strictEqual(result, true);
  assert.deepStrictEqual(mockClient.calls[0], { method: 'from', args: ['licensed_agents'] });
  assert.strictEqual(mockClient.calls[1].method, 'upsert');
  assert.strictEqual(mockClient.calls[1].args[1].onConflict, 'license_number');
  assert.strictEqual(mockClient.calls[3].method, 'delete');
  assert.strictEqual(mockClient.calls[4].method, 'lt');
});

test('licenseRegistry - syncLicensedAgents devuelve false (sin lanzar) si el fetch falla', async () => {
  const mockClient = makeMockSyncClient();
  const result = await syncLicensedAgents(mockClient as any, makeFakeFetch('', false, 500));
  assert.strictEqual(result, false);
});

test('licenseRegistry - syncLicensedAgents devuelve false si el HTML no tiene filas válidas', async () => {
  const mockClient = makeMockSyncClient();
  const result = await syncLicensedAgents(mockClient as any, makeFakeFetch('<html></html>'));
  assert.strictEqual(result, false);
});

test('licenseRegistry - syncLicensedAgents devuelve false si Supabase falla en el upsert', async () => {
  const mockClient = makeMockSyncClient({ upsertError: { message: 'fallo simulado' } });
  const result = await syncLicensedAgents(mockClient as any, makeFakeFetch(PADRON_FIXTURE_HTML));
  assert.strictEqual(result, false);
});

// Mock encadenable para resolveLicenseValidationStatus: select().order().limit().maybeSingle()
// (chequeo de antigüedad) y select().eq().maybeSingle() (match de matrícula).
function makeMockResolveClient(options: { freshest?: { synced_at: string } | null; match?: { license_number: string } | null }) {
  let selectCallIndex = 0;
  const freshestBuilder: any = {
    order: () => freshestBuilder,
    limit: () => freshestBuilder,
    maybeSingle: () => Promise.resolve({ data: options.freshest ?? null, error: null })
  };
  const matchBuilder: any = {
    eq: () => matchBuilder,
    maybeSingle: () => Promise.resolve({ data: options.match ?? null, error: null })
  };
  return {
    from: () => ({
      select: () => {
        selectCallIndex++;
        return selectCallIndex === 1 ? freshestBuilder : matchBuilder;
      }
    })
  };
}

test('licenseRegistry - resolveLicenseValidationStatus devuelve pending si la caché está vacía', async () => {
  const client = makeMockResolveClient({ freshest: null });
  const status = await resolveLicenseValidationStatus('001', client as any);
  assert.strictEqual(status, 'pending');
});

test('licenseRegistry - resolveLicenseValidationStatus devuelve pending si la caché está desactualizada', async () => {
  const staleDate = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(); // 100h atrás > 48h default
  const client = makeMockResolveClient({ freshest: { synced_at: staleDate } });
  const status = await resolveLicenseValidationStatus('001', client as any);
  assert.strictEqual(status, 'pending');
});

test('licenseRegistry - resolveLicenseValidationStatus devuelve validated si la matrícula matchea en una caché fresca', async () => {
  const freshDate = new Date().toISOString();
  const client = makeMockResolveClient({ freshest: { synced_at: freshDate }, match: { license_number: '001' } });
  const status = await resolveLicenseValidationStatus('001', client as any);
  assert.strictEqual(status, 'validated');
});

test('licenseRegistry - resolveLicenseValidationStatus devuelve rejected si no matchea en una caché fresca', async () => {
  const freshDate = new Date().toISOString();
  const client = makeMockResolveClient({ freshest: { synced_at: freshDate }, match: null });
  const status = await resolveLicenseValidationStatus('999999', client as any);
  assert.strictEqual(status, 'rejected');
});
