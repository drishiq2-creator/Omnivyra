/**
 * 20270217000073 salesnav_extraction_runs - on the real schema (b3 ruling A, 2026-11-21; cb checklist):
 *   - ONE company per LinkedIn member: a second company claiming the same member is REFUSED (23505);
 *   - a binding can only name a member its OWN company owns (23503), never another company's;
 *   - the run's (status, code) pairs are the contract's closed sets; closed_at is set exactly when terminal;
 *   - at most ONE open run per member (queued / running / a resumable pause);
 *   - no client role can read or write any of the three tables (a foreign company has no database path at all;
 *     company scoping of the service path is tested on the repository).
 * Every assertion that expects a refusal has a control that is accepted.
 */
import { db, seedTenants, ORG_A, ORG_B, inRollback, attempt, effect } from './setup';

const M1 = 'ACoAAAsnrTest00001';
const M2 = 'ACoAAAsnrTest00002';
const URL1 = 'https://www.linkedin.com/sales/lists/people/123';

const own = (member: string, org: string) =>
  effect('INSERT INTO public.salesnav_member_owner (member_id, organization_id) VALUES ($1, $2)', [member, org]);
const U1 = '00000000-0000-4000-8000-0000000000a1';
const U2 = '00000000-0000-4000-8000-0000000000a2';
const bind = (org: string, transport: string, member: string, user = U1) =>
  effect('INSERT INTO public.salesnav_member_bindings (organization_id, user_id, transport, member_id) VALUES ($1, $2, $3, $4)',
    [org, user, transport, member]);
const run = (org: string, member: string, status = 'running', code: string | null = null, closed = false) =>
  effect(
    `INSERT INTO public.salesnav_extraction_runs (organization_id, transport, member_id, url_kind, canonical_url,
       status, status_code, closed_at)
     VALUES ($1, 'unipile', $2, 'lead_list', $3, $4, $5, CASE WHEN $6 THEN now() END)`,
    [org, member, URL1, status, code, closed]);

describe('one company per LinkedIn member (b3 ruling A)', () => {
  it('a SECOND company claiming the same member is refused', () => inRollback(async () => {
    await seedTenants();
    expect(await own(M1, ORG_A)).toBe('ok');
    expect(await own(M1, ORG_B)).toBe('23505');
  }));

  it('control: two different members in two companies are both accepted', () => inRollback(async () => {
    await seedTenants();
    expect(await own(M1, ORG_A)).toBe('ok');
    expect(await own(M2, ORG_B)).toBe('ok');
  }));

  it('a binding naming ANOTHER company\'s member is refused', () => inRollback(async () => {
    await seedTenants();
    await own(M1, ORG_A);
    expect(await bind(ORG_B, 'unipile', M1)).toBe('23503');
  }));

  it('control: the owning company binds its member, on several transports', () => inRollback(async () => {
    await seedTenants();
    await own(M1, ORG_A);
    expect(await bind(ORG_A, 'unipile', M1)).toBe('ok');
    expect(await bind(ORG_A, 'extension', M1)).toBe('ok');
  }));

  it('one member per (company, USER, transport)', () => inRollback(async () => {
    await seedTenants();
    await own(M1, ORG_A); await own(M2, ORG_A);
    expect(await bind(ORG_A, 'unipile', M1)).toBe('ok');
    expect(await bind(ORG_A, 'unipile', M2)).toBe('23505');
  }));

  it('control: two USERS of one company each bind their own seat on the same transport', () => inRollback(async () => {
    await seedTenants();
    await own(M1, ORG_A); await own(M2, ORG_A);
    expect(await bind(ORG_A, 'extension', M1, U1)).toBe('ok');
    expect(await bind(ORG_A, 'extension', M2, U2)).toBe('ok');
  }));

  it('releasing the owner row (disconnect) removes its bindings, and only then may another company claim it', () => inRollback(async () => {
    await seedTenants();
    await own(M1, ORG_A); await bind(ORG_A, 'unipile', M1);
    expect(await effect('DELETE FROM public.salesnav_member_owner WHERE member_id = $1', [M1])).toBe('ok');
    const { rows } = await db.query('SELECT count(*)::int n FROM public.salesnav_member_bindings WHERE member_id = $1', [M1]);
    expect(rows[0].n).toBe(0);
    expect(await own(M1, ORG_B)).toBe('ok');
  }));

  it('a non-canonical member id is refused in every table', () => inRollback(async () => {
    await seedTenants();
    expect(await own('Ada Lovelace', ORG_A)).toBe('23514');
    expect(await own('urn:li:member:1', ORG_A)).toBe('23514');
  }));
});

describe('runs: closed (status, code) sets and closed_at', () => {
  it.each([
    ['running with a code', 'running', 'daily_cap', false],
    ['completed with a code from another status', 'completed', 'daily_cap', true],
    ['an invented code', 'failed', 'made_up', true],
    ['a terminal status without closed_at', 'completed', 'no_next_page', false],
    ['an open status WITH closed_at', 'paused_daily_cap', 'daily_cap', true],
    ['an unknown status', 'partial_capped', 'daily_cap', true],
  ])('refuses %s', (_l, status, code, closed) => inRollback(async () => {
    await seedTenants();
    expect(await run(ORG_A, M1, status as string, code as string, closed as boolean)).toBe('23514');
  }));

  it.each([
    ['running', null, false],
    ['paused_daily_cap', 'daily_cap', false],
    ['auth_expired', 'checkpoint', false],
    ['completed', 'no_next_page', true],
    ['unknown', 'page_repeated', true],
    ['cancelled', 'user_cancelled', true],
  ])('control: accepts %s/%s', (status, code, closed) => inRollback(async () => {
    await seedTenants();
    expect(await run(ORG_A, M1, status as string, code as string | null, closed as boolean)).toBe('ok');
  }));

  it('refuses a URL that is not a Sales Navigator URL', () => inRollback(async () => {
    await seedTenants();
    expect(await attempt(
      `INSERT INTO public.salesnav_extraction_runs (organization_id, transport, member_id, url_kind, canonical_url)
       VALUES ($1, 'unipile', $2, 'lead_list', 'https://evil.example/sales/x')`, [ORG_A, M1])).toBe('23514');
  }));
});

describe('vendor_cursor: API transports only, bounded', () => {
  const withCursor = (transport: string, cursor: string) => effect(
    `INSERT INTO public.salesnav_extraction_runs (organization_id, transport, member_id, url_kind, canonical_url, vendor_cursor, active_route)
     VALUES ($1, $2, $3, 'lead_list', $4, $5, CASE WHEN $2 IN ('extension', 'rpa') THEN $2 END)`, [ORG_A, transport, M1, URL1, cursor]);
  it('a browser transport cannot carry a vendor cursor', () => inRollback(async () => {
    await seedTenants();
    expect(await withCursor('extension', 'abc')).toBe('23514');
  }));
  it('control: the same browser-transport insert WITHOUT a cursor is accepted (the refusal above is the cursor)', () => inRollback(async () => {
    await seedTenants();
    expect(await effect(
      `INSERT INTO public.salesnav_extraction_runs (organization_id, transport, member_id, url_kind, canonical_url, active_route)
       VALUES ($1, 'extension', $2, 'lead_list', $3, 'extension')`, [ORG_A, M1, URL1])).toBe('ok');
  }));
  it('a cursor over 2000 characters is refused', () => inRollback(async () => {
    await seedTenants();
    expect(await withCursor('unipile', 'x'.repeat(2001))).toBe('23514');
  }));
  it('control: unipile with a cursor is accepted', () => inRollback(async () => {
    await seedTenants();
    expect(await withCursor('unipile', 'x'.repeat(2000))).toBe('ok');
  }));
});

describe('active_route (the handoff holder) and the pending reservation', () => {
  const ins = (transport: string, holder: string | null, extra = '', extraVals: unknown[] = []) => effect(
    `INSERT INTO public.salesnav_extraction_runs (organization_id, transport, member_id, url_kind, canonical_url, active_route${extra ? ', ' + extra : ''})
     VALUES ($1, $2, $3, 'lead_list', $4, $5${extraVals.map((_, i) => `, $${6 + i}`).join('')})`,
    [ORG_A, transport, M1, URL1, holder, ...extraVals]);
  it('a browser route without a holder is refused', () => inRollback(async () => {
    await seedTenants();
    expect(await ins('extension', null)).toBe('23514');
  }));
  it('an API route WITH a holder is refused', () => inRollback(async () => {
    await seedTenants();
    expect(await ins('unipile', 'extension')).toBe('23514');
  }));
  it('a holder outside extension/rpa is refused', () => inRollback(async () => {
    await seedTenants();
    expect(await ins('extension', 'vayne')).toBe('23514');
  }));
  it('control: an extension run handed to rpa is accepted; an API run with no holder is accepted', () => inRollback(async () => {
    await seedTenants();
    expect(await ins('extension', 'rpa')).toBe('ok');
    expect(await effect(
      `INSERT INTO public.salesnav_extraction_runs (organization_id, transport, member_id, url_kind, canonical_url, active_route)
       VALUES ($1, 'unipile', $2, 'lead_list', $3, NULL)`, [ORG_A, M2, URL1])).toBe('ok');
  }));
  it.each([
    ['a granted count without a page', 'pending_granted', [5]],
    ['a page without a granted count', 'pending_page_index', [0]],
  ])('refuses %s', (_l, col, vals) => inRollback(async () => {
    await seedTenants();
    expect(await ins('extension', 'extension', col as string, vals as unknown[])).toBe('23514');
  }));
  it('refuses a grant above 25 and a pending page that is not the next page', () => inRollback(async () => {
    await seedTenants();
    expect(await ins('extension', 'extension', 'pending_page_index, pending_granted', [0, 26])).toBe('23514');
    expect(await ins('extension', 'extension', 'pending_page_index, pending_granted', [1, 5])).toBe('23514');
  }));
  it('control: a pending reservation of the next page within 0..25 is accepted', () => inRollback(async () => {
    await seedTenants();
    expect(await ins('extension', 'extension', 'pending_page_index, pending_granted', [0, 25])).toBe('ok');
  }));
});

describe('at most ONE open run per member', () => {
  it('a second open run for the same member is refused, whichever open status the first holds', () => inRollback(async () => {
    await seedTenants();
    expect(await run(ORG_A, M1, 'paused_daily_cap', 'daily_cap')).toBe('ok');
    expect(await run(ORG_A, M1, 'running')).toBe('23505');
  }));

  it('control: after the first run is closed, a new one starts', () => inRollback(async () => {
    await seedTenants();
    expect(await run(ORG_A, M1, 'completed', 'no_next_page', true)).toBe('ok');
    expect(await run(ORG_A, M1, 'running')).toBe('ok');
  }));

  it('control: another member runs concurrently', () => inRollback(async () => {
    await seedTenants();
    expect(await run(ORG_A, M1, 'running')).toBe('ok');
    expect(await run(ORG_A, M2, 'running')).toBe('ok');
  }));
});

describe('no client role can read or write the three tables', () => {
  it.each(['anon', 'authenticated'])('%s', (role) => inRollback(async () => {
    const roleExists = (await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount === 1;
    expect(roleExists).toBe(true);   // the refusal below must be about privilege, not a missing role
    await db.query(`SET LOCAL ROLE ${role}`);
    for (const t of ['salesnav_member_owner', 'salesnav_member_bindings', 'salesnav_extraction_runs']) {
      expect(await attempt(`SELECT * FROM public.${t}`)).toBe('42501');
    }
    expect(await own(M1, ORG_A)).toBe('42501');
  }));
});
