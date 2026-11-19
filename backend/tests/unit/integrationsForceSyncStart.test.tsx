/**
 * @jest-environment jsdom
 *
 * b3 2026-11-20: a lost connection on "start a manual sync" is an UNKNOWN outcome. It must never be shown
 * as the server's 503 "Nothing was started" (the sync may in fact have been queued).
 */
import { readForceSyncStart } from '../../../components/integrationsController';
import { NETWORK_FAILURE_STATUS, NETWORK_FAILURE_CODE } from '../../../lib/networkFailure';

// jsdom has no global Response; a minimal fake with the fields readForceSyncStart reads.
const resp = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  }) as unknown as Response;

describe('readForceSyncStart', () => {
  it('apiFetch lost connection → "not sure it started", never "Nothing was started"', async () => {
    const r = await readForceSyncStart(resp(NETWORK_FAILURE_STATUS, { error: 'Network unreachable', code: NETWORK_FAILURE_CODE }));
    expect(r).toEqual({ kind: 'failed', message: 'We’re not sure the sync started. Check the sync status before starting another.' });
    expect(JSON.stringify(r)).not.toMatch(/Nothing was started/);
  });
  it('control: a REAL server 503 keeps the server refusal ("Nothing was started")', async () => {
    const r = await readForceSyncStart(resp(503, {}));
    expect(r).toEqual({ kind: 'failed', message: 'The sync queue is unavailable. Nothing was started; try again shortly.' });
  });
  it('unchanged: 400 no property, other failures, and a start', async () => {
    expect(await readForceSyncStart(resp(400, { error: 'no_active_property' }))).toEqual({ kind: 'no_property' });
    expect(await readForceSyncStart(resp(500, { error: 'boom' }))).toEqual({ kind: 'failed', message: 'boom' });
    expect(await readForceSyncStart(resp(202, { status: 'queued', jobId: 'j1' }))).toEqual({ kind: 'started', data: { status: 'queued', jobId: 'j1' } });
  });
});
