import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';

// KAN-142: harness mínimo (sin dependencias nuevas) para probar los routers de src/routes/*
// end-to-end contra un servidor HTTP real en un puerto efímero. No usamos supertest (no es una
// dependencia del repo) — alcanza con `fetch` (nativo desde Node 18+) contra `http.Server.listen(0)`.
// Ver docs/evolucion_proyecto/refactor_index_routes.md para el resto del contrato de testing de
// las rutas extraídas.

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startTestServer(router: express.Router): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(router);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('No se pudo determinar el puerto del servidor de test.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    })
  };
}
