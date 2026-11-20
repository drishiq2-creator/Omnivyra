/**
 * The worker's health-server port becomes PUBLIC (a Railway domain) so the hosted metrics scraper can reach /metrics
 * (b3, 2026-11-20). Before the owner gives it a domain, this pins what a stranger can learn from that port:
 *   - /health answers STATUS ONLY: exactly { status, uptime, cron_status, ts } - no free-text reason (a raw
 *     startCron error can name hosts or connection details), no version, no env.
 *   - every token-gated route answers 404 to EVERY method while its token is unset (indistinguishable from a
 *     missing route), and 401 to a wrong token once set.
 *   - every other path answers 404.
 *   - POPULATION: the routes this test covers are exactly the routes the server source declares, so a new route
 *     fails here until it is classified.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { startHealthServer, setCronStatus } from '../../workers/healthServer';

const SRC = fs.readFileSync(path.resolve(__dirname, '../../workers/healthServer.ts'), 'utf8');
const TOKEN_ROUTES: Record<string, { env: string; method: string; header: string }> = {
  '/metrics': { env: 'OBSERVABILITY_EXPORT_TOKEN', method: 'GET', header: 'authorization' },
  '/internal/ads-acquisition': { env: 'ADS_ACQUISITION_TRIGGER_TOKEN', method: 'POST', header: 'x-ads-trigger-secret' },
};
const PUBLIC_ROUTES = ['/health'];

describe('worker public port surface', () => {
  let server: http.Server;
  let port: number;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const { env } of Object.values(TOKEN_ROUTES)) { saved[env] = process.env[env]; delete process.env[env]; }
    server = startHealthServer(0);
    await new Promise<void>((resolve) => server.on('listening', () => resolve()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => {
    server.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  afterEach(() => { for (const { env } of Object.values(TOKEN_ROUTES)) delete process.env[env]; });

  const call = (p: string, method = 'GET', headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${p}`, { method, headers });

  it('POPULATION: the server declares exactly the routes classified here', () => {
    const declared = [...SRC.matchAll(/(?:path|req\.url) === '([^']+)'/g)].map((m) => m[1]).sort();
    expect(declared.length).toBeGreaterThan(0);
    expect(declared).toEqual([...Object.keys(TOKEN_ROUTES), ...PUBLIC_ROUTES].sort());
  });

  it('/health is status only, even while cron is degraded by an error that names a host', async () => {
    setCronStatus('degraded', 'connect ECONNREFUSED redis://worker:s3cret@10.0.0.5:6379');
    try {
      const r = await call('/health');
      expect(r.status).toBe(200);
      const text = await r.text();
      const body = JSON.parse(text) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['cron_status', 'status', 'ts', 'uptime']);
      expect(body).toMatchObject({ status: 'ok', cron_status: 'degraded' });
      for (const leak of ['ECONNREFUSED', 'redis', 's3cret', '10.0.0.5', 'CRON_SERVICE_MODE']) expect(text).not.toContain(leak);
    } finally {
      setCronStatus('ok');
    }
  });

  it.each(Object.entries(TOKEN_ROUTES).flatMap(([p]) => ['GET', 'POST', 'PUT', 'DELETE'].map((m) => [p, m])))(
    '%s %s with its token UNSET -> 404 (no 405 that would confirm the route exists)',
    async (p, method) => {
      expect((await call(p, method)).status).toBe(404);
    },
  );

  it.each(Object.entries(TOKEN_ROUTES))('%s with its token SET and a wrong value -> 401', async (p, { env, method, header }) => {
    process.env[env] = 'the-right-token';
    const value = header === 'authorization' ? 'Bearer wrong' : 'wrong';
    expect((await call(p, method, { [header]: value })).status).toBe(401);
  });

  it.each(['/', '/env', '/.env', '/debug', '/version', '/health/x', '/metrics/x', '/internal', '/internal/other'])(
    'an undeclared path %s -> 404',
    async (p) => {
      expect((await call(p)).status).toBe(404);
    },
  );

  it('POST /health -> 404 (only GET is served)', async () => {
    expect((await call('/health', 'POST')).status).toBe(404);
  });
});
