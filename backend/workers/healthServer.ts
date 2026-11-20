/**
 * Minimal HTTP health server for Railway health checks.
 * Railway pings GET /health to determine if the container is alive.
 * Must respond within the healthcheckTimeout (30s) or Railway restarts the pod.
 */

import http from 'http';
import { renderPrometheusText, PROMETHEUS_CONTENT_TYPE } from '../observability';
import { constantTimeEqual } from '../security/constantTimeEqual';

let _startedAt = Date.now();

/**
 * Same token contract as pages/api/observability/metrics.ts — a Bearer token
 * or a secret header, checked against a configured value.
 * Reused verbatim so the worker scrape target authenticates identically to
 * the API target; no separate auth scheme.
 *
 * PO-3 F1: parameterised on the alternate header name ONLY. The ads trigger
 * authenticates by exactly this algorithm rather than a second one.
 */
function presentedToken(req: http.IncomingMessage, altHeader: string): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const secret = req.headers[altHeader];
  if (typeof secret === 'string' && secret.trim()) return secret.trim();
  return undefined;
}

function presentedMetricsToken(req: http.IncomingMessage): string | undefined {
  return presentedToken(req, 'x-metrics-secret');
}

// Cron status reporter. Workers continue running even if cron init
// fails (the comment in main.ts:272 explicitly documents this as a
// non-fatal failure mode). But the failure was previously SILENT —
// token-refresh stops, posts fail 2 hours later, operator has no
// signal. Exposing the degraded state in the health response gives
// operators an immediate signal without crash-looping the pod.
type CronStatus = 'ok' | 'degraded' | 'initializing';
let _cronStatus: CronStatus = 'initializing';

/**
 * Worker-side setter for cron health. Called by main.ts from the
 * startCron() failure handler. Idempotent — successive calls overwrite.
 *
 * STATUS ONLY, by signature: there is deliberately no reason/message parameter. /health is served on a PUBLIC port,
 * and the reason a caller has is a raw error message (it can name hosts or connection details). Do NOT add one to
 * store or serve it - log it where it is raised (main.ts does). CronStatus is a closed union for the same reason.
 */
export function setCronStatus(status: CronStatus): void {
  _cronStatus = status;
}

export function startHealthServer(port = 8080): http.Server {
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];

    // Prometheus scrape target (F-02, worker side) — the SAME exporter, registry,
    // token, header convention, and output format as the API endpoint
    // (pages/api/observability/metrics.ts). This exposes the worker process's
    // in-process HARDEN-001 registry; it does not create a second registry.
    // Dark by default: 404 when OBSERVABILITY_EXPORT_TOKEN is unset — identical
    // to the API and indistinguishable from a missing route.
    if (path === '/metrics') {
      // Dark check FIRST, for every method: a 405 before it would confirm the route exists (public port).
      const expected = process.env.OBSERVABILITY_EXPORT_TOKEN;
      if (!expected) { res.writeHead(404); res.end(); return; }
      if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
      // SEC-C4: constant-time comparison (no prefix-timing oracle).
      if (!constantTimeEqual(presentedMetricsToken(req), expected)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      try {
        const body = renderPrometheusText();
        res.writeHead(200, { 'Content-Type': PROMETHEUS_CONTENT_TYPE, 'Cache-Control': 'no-store' });
        res.end(body);
      } catch (err) {
        // The exporter is fail-safe by contract; guard anyway so a scrape can
        // never take the worker down.
        res.writeHead(500);
        res.end();
      }
      return;
    }

    // PO-3 F1 — controlled operational trigger for one Ads Transparency acquisition cycle.
    //
    // WHY IT EXISTS: `scheduleWorker` arms a setTimeout for ADS_ACQUISITION_INTERVAL_MS (24h) and
    // never runs at boot, and the timer restarts with the worker — which Railway does on every
    // deploy. Without this there is no way to observe a first cycle inside a monitored window.
    // It lives here, on the worker, because acquisition needs real Playwright Chromium; the
    // Vercel plane carries @sparticuz/chromium (setContent only) and cannot run it.
    //
    // WHAT IT IS NOT: it is not a second enable switch. It controls WHEN a cycle runs;
    // ADS_TRANSPARENCY_ACQUISITION_ENABLED still controls WHETHER acquisition may happen, and is
    // read inside runAdsAcquisitionCycle before any subject read or browser launch. With the flag
    // off this returns `{ enabled: 0 }` and contacts no provider.
    //
    // Dark by default: 404 when ADS_ACQUISITION_TRIGGER_TOKEN is unset — same convention as
    // /metrics, indistinguishable from a missing route.
    if (path === '/internal/ads-acquisition') {
      // Dark check FIRST, for every method (see /metrics).
      const expected = process.env.ADS_ACQUISITION_TRIGGER_TOKEN;
      if (!expected) { res.writeHead(404); res.end(); return; }
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
      // SEC-C4: constant-time comparison (no prefix-timing oracle). The presented value is
      // never logged and never echoed into a response body.
      if (!constantTimeEqual(presentedToken(req, 'x-ads-trigger-secret'), expected)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      void (async () => {
        try {
          const { runGuardedAdsAcquisitionCycle } =
            await import('../services/ads/adsAcquisitionRunner');
          const outcome = await runGuardedAdsAcquisitionCycle();
          if (outcome.status === 'already_running') {
            // 409, not a queued second cycle: an operator asking while one is in flight wants
            // to be told, not to stack another fan-out behind it.
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, status: 'already_running' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, status: 'completed', counters: outcome.result }));
        } catch {
          // The runner is fail-safe by contract; guard anyway so a trigger can never take the
          // worker down. No error detail is echoed — it could carry request-derived content.
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, status: 'error' }));
        }
      })();
      return;
    }

    if (path === '/health' && req.method === 'GET') {
      // HTTP status remains 200 even when cron is degraded — Railway's
      // healthcheck only restarts on 5xx, and a crash-loop here would
      // hurt more than the degraded scheduler. Operators read the
      // cron_status field; alerts can be configured on it directly.
      // PUBLIC (the worker's port gets a public domain so the metrics scraper can reach it): status only.
      // The free-text degraded reason is a raw startCron error message - it can name hosts or connection
      // details - so it is NOT served or stored here; main.ts logs it where it is raised.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        uptime: Math.floor((Date.now() - _startedAt) / 1000),
        cron_status: _cronStatus,
        ts:     Date.now(),
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    console.info(`[health] server listening on :${port}`);
  });

  server.on('error', (err) => {
    console.error('[health] server error:', err);
  });

  return server;
}
