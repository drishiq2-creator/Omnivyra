/**
 * seamDenial - the ONE way a request handler answers a TenantSeamError (e9 + 05, 2026-11-14).
 *
 *  - A RETRYABLE seam error (TenantSeamError.retryable: a parent row that could not be READ, e.g. a statement
 *    timeout) -> 503 + Retry-After with a plain "try again" body. It is not a denial: the tenant check could not run.
 *  - Any other seam error (absent / foreign / mismatched parent, missing context) -> the route's own uniform denial
 *    (the status + body the route already used, typically 404 "... not found" or its 403).
 *  - TENANT_PARENT_FANOUT (coordinator ruling, 2026-11-18): the client sees EXACTLY the route's uniform denial (no
 *    distinct status, body or extra query - a fan-out answer must not become an existence / shape oracle). It is an
 *    availability limit, not a tenant mismatch, so the server ALSO raises it: an ERROR-level structured log
 *    `tenant_parent_fanout` {table, parentTable, key, limit} and the counter `tenant_parent_fanout_total{table}`
 *    (HARDEN-001 registry -> Prometheus text on /api/observability/metrics and the worker /metrics). The fields are
 *    parsed from the seam's own message and the generated registry; `key` is the key COLUMN name, never its value.
 *
 * The body never carries the parent id or the underlying error. NOT an existence oracle: the retryable path fires
 * on a READ FAILURE before ownership is known, so it answers identically for an owned and a foreign id.
 *
 * scripts / backend/tests/unit/seamDenialStructural.test.ts pins that every pages/api catch of TenantSeamError goes
 * through here (no local copies), with reviewed exemptions only.
 */
import type { NextApiResponse } from 'next';
import type { TenantSeamError } from './tenantTable';
import { TENANT_CHILD_TABLES } from './tenantTables';
import { logger } from '../services/logger';
import { recordRawCounter } from '../observability/metrics';

export const SEAM_RETRY_AFTER_SECONDS = 5;
export const SEAM_RETRY_BODY = Object.freeze({
  error: "We couldn't load this right now. Please try again.",
  code: 'TEMPORARILY_UNAVAILABLE',
});

export const TENANT_PARENT_FANOUT_EVENT = 'tenant_parent_fanout';
/** Registry counter name; exported to Prometheus unchanged (underscores only). */
export const TENANT_PARENT_FANOUT_COUNTER = 'tenant_parent_fanout_total';

export type FanoutFields = { table: string; parentTable: string | null; key: string | null; limit: number | null };

type ChildSpec = { via: string; parent: string; parentKey?: string };
const childSpec = (t: string): ChildSpec | undefined => (TENANT_CHILD_TABLES as Record<string, ChildSpec | undefined>)[t];
const IDENT = /^[a-z_][a-z0-9_]*$/;

/** The key column verifyParent queried `parentTable` on, found by walking the child's registry chain. */
function keyColumnFor(child: string, parentTable: string): string | null {
  let spec = childSpec(child);
  for (let hop = 0; spec && hop < 8; hop++) {
    if (spec.parent === parentTable) return spec.parentKey ?? 'id';
    spec = childSpec(spec.parent);
  }
  return null;
}

/**
 * Parses the two fan-out messages tenantTable.ts throws (verifyParent's fanout() and tenantChildTableOf's batch
 * limit). Only identifiers and the numeric limit are extracted: nothing of the message that could carry a value.
 */
export function parseFanout(message: string): FanoutFields {
  // TenantSeamError prefixes its message with the code ("TENANT_PARENT_FANOUT: <table>: ...").
  const msg = String(message ?? '').replace(/^TENANT_[A-Z_]+: /, '');
  const perKey = /^([a-z_][a-z0-9_]*): parent key matches more than (\d+) ([a-z_][a-z0-9_]*) rows/.exec(msg);
  if (perKey) {
    const [, table, limit, parentTable] = perKey;
    return { table, parentTable, key: keyColumnFor(table, parentTable), limit: Number(limit) };
  }
  const batch = /^([a-z_][a-z0-9_]*): \d+ parents in one call \(limit (\d+);/.exec(msg);
  if (batch) {
    const [, table, limit] = batch;
    const spec = childSpec(table);
    return { table, parentTable: spec?.parent ?? null, key: spec ? spec.parentKey ?? 'id' : null, limit: Number(limit) };
  }
  const lead = /^([a-z_][a-z0-9_]*):/.exec(msg);
  return { table: lead && IDENT.test(lead[1]) ? lead[1] : 'unknown', parentTable: null, key: null, limit: null };
}

/**
 * Raises the fanout signal (ERROR log + counter) for a TENANT_PARENT_FANOUT and returns true; any other error is
 * ignored (false). For catches that must stay NON-blocking or answer through their own path (a swallowed best-effort
 * write, a service that maps the refusal to its own not-found): the availability limit is still alertable there.
 * Never throws.
 */
export function reportTenantFanout(err: unknown): boolean {
  if (!(err instanceof Error) || (err as { code?: unknown }).code !== 'TENANT_PARENT_FANOUT') return false;
  try {
    const fields = parseFanout(err.message);
    logger.error(TENANT_PARENT_FANOUT_EVENT, { ...fields });
    recordRawCounter(TENANT_PARENT_FANOUT_COUNTER, 1, { table: fields.table });
  } catch {
    /* observability must never change the response */
  }
  return true;
}

export function seamDenial(
  res: NextApiResponse,
  err: TenantSeamError,
  denyStatus: number,
  denyBody: Record<string, unknown>,
) {
  if (err.retryable) {
    res.setHeader('Retry-After', String(SEAM_RETRY_AFTER_SECONDS));
    return res.status(503).json(SEAM_RETRY_BODY);
  }
  reportTenantFanout(err);
  return res.status(denyStatus).json(denyBody);
}
