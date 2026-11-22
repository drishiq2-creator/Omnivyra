/**
 * "Message on LinkedIn" from a lead in Prospects (owner-approved 2026-11-22):
 *   - the request is one PENDING action in the existing approved-actions workflow, with NO execution mode yet (so
 *     neither the extension hand-out nor the abandoned-dispatch recovery can touch it before approval);
 *   - recipient (lead's Sales Navigator profile link) and sender (requesting user + their linked LinkedIn account) are
 *     resolved on the server; a failed read is 503, never "no profile" / "not linked";
 *   - the executor turns an approved request into ONE genuine start_new_dm step, never a continuation, and always
 *     by browser; ordinary LinkedIn DMs are unchanged.
 * Plus the sign-in finding 4 (a product-scoped code is not redeemable without a product) and the page's reply filter.
 */
jest.mock('../../db/supabaseClient', () => ({ supabase: {} }));
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: () => { throw new Error('no database in this test'); } }));

import { requestLinkedInNewDm, canonicalProfileUrl } from '../../services/linkedinNewDm/requestService';
import { buildDmCommandChain, resolveExecutionMode } from '../../services/communityAiActionExecutorContracts';
import { claimCodeTableFake } from '../helpers/claimCodeTableFake';
import { autoSignInAllowed, readSalesNavExtensionState } from '../../../lib/prospects/salesnav/salesNavExtensionLink';

const ORG = 'org-1';
const USER = 'user-1';
const LEAD = 'lead-1';
const PERSON = 'person-1';
const MEMBER = 'ACoAAMEMEMEMEMEMEMEMEMEMEME01';

type Row = Record<string, any>;
function fakeDb(opts: { leads?: Row[]; records?: Row[]; actions?: Row[]; fail?: string[] } = {}) {
  const tables: Record<string, Row[]> = {
    canonical_leads: opts.leads ?? [{ id: LEAD, company_id: ORG, unified_person_id: PERSON }],
    source_records: opts.records ?? [{ organization_id: ORG, person_id: PERSON, provider: 'linkedin_sales_navigator', raw_payload: { public_profile_url: 'https://www.linkedin.com/in/alice-example' } }],
    community_ai_actions: opts.actions ?? [],
  };
  const inserted: Row[] = [];
  const table = (name: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const q: any = {
      select: () => q,
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
      in: (k: string, v: unknown[]) => { filters.push((r) => v.includes(r[k])); return q; },
      limit: async () => ((opts.fail ?? []).includes(`${name}.select`)
        ? { data: null, error: { message: 'down' } }
        : { data: (tables[name] ?? []).filter((r) => filters.every((f) => f(r))), error: null }),
      insert: async (row: Row) => {
        if ((opts.fail ?? []).includes(`${name}.insert`)) return { error: { message: 'down' } };
        inserted.push(row); (tables[name] = tables[name] ?? []).push(row); return { error: null };
      },
    };
    return q;
  };
  return { table, inserted, tables };
}
const req = (db: ReturnType<typeof fakeDb>, over: Row = {}, member: string | null | 'unreadable' = MEMBER) =>
  requestLinkedInNewDm({ organizationId: ORG, userId: USER, prospectId: LEAD, text: 'Hello Alice', ...over },
    { table: db.table, memberFor: async () => member, newId: () => 'action-1', now: () => new Date('2026-11-22T10:00:00Z') });

describe('Message on LinkedIn: the request', () => {
  it('CONTROL: queues ONE pending action that needs approval, tied to the lead, the sender and their LinkedIn account', async () => {
    const db = fakeDb();
    expect(await req(db)).toEqual({ ok: true, actionId: 'action-1', recipientProfileUrl: 'https://www.linkedin.com/in/alice-example/', senderMemberId: MEMBER });
    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0]).toMatchObject({
      organization_id: ORG, platform: 'linkedin', action_type: 'dm', target_id: 'https://www.linkedin.com/in/alice-example/',
      suggested_text: 'Hello Alice', status: 'pending', requires_human_approval: true, requires_approval: true,
      execution_mode: null, acting_user_id: USER, dm_lead_id: LEAD, dm_sender_member_id: MEMBER,
    });
    expect(db.inserted[0].approved_at).toBeUndefined();
  });

  it.each([
    ['no Sales Navigator profile link', { records: [] }, 409, 'NO_LINKEDIN_PROFILE'],
    ['only a /sales/ app link (never a recipient)', { records: [{ organization_id: ORG, person_id: PERSON, provider: 'linkedin_sales_navigator', raw_payload: { public_profile_url: 'https://www.linkedin.com/sales/lead/ACwAA,NAME' } }] }, 409, 'NO_LINKEDIN_PROFILE'],
    ['two DIFFERENT profile links', { records: [
      { organization_id: ORG, person_id: PERSON, provider: 'linkedin_sales_navigator', raw_payload: { public_profile_url: 'https://www.linkedin.com/in/alice-a/' } },
      { organization_id: ORG, person_id: PERSON, provider: 'linkedin_sales_navigator', raw_payload: { public_profile_url: 'https://www.linkedin.com/in/alice-b/' } }] }, 409, 'LINKEDIN_PROFILE_AMBIGUOUS'],
    ['a lead of another company', { leads: [{ id: LEAD, company_id: 'org-2', unified_person_id: PERSON }] }, 404, 'PROSPECT_NOT_FOUND'],
    ['the lead read fails', { fail: ['canonical_leads.select'] }, 503, 'LEAD_UNREADABLE'],
    ['the evidence read fails', { fail: ['source_records.select'] }, 503, 'LEAD_UNREADABLE'],
    ['the pending-check read fails', { fail: ['community_ai_actions.select'] }, 503, 'ACTIONS_UNREADABLE'],
    ['the insert fails', { fail: ['community_ai_actions.insert'] }, 503, 'ACTION_NOT_RECORDED'],
  ])('%s -> %p %p, nothing queued', async (_label, dbOpts, status, error) => {
    const db = fakeDb(dbOpts as any);
    expect(await req(db)).toEqual({ ok: false, status, error });
    expect(db.inserted).toHaveLength(0);
  });

  it('the same link seen twice in different forms is ONE recipient (not ambiguous)', async () => {
    const db = fakeDb({ records: [
      { organization_id: ORG, person_id: PERSON, provider: 'linkedin_sales_navigator', raw_payload: { public_profile_url: 'https://www.linkedin.com/in/alice-example/' } },
      { organization_id: ORG, person_id: PERSON, provider: 'linkedin_sales_navigator', raw_payload: { public_profile_url: 'http://linkedin.com/in/alice-example?trk=x' } }] });
    expect((await req(db)).ok).toBe(true);
  });

  it('sender not linked -> 409; sender binding unreadable -> 503 (never "not linked"); nothing queued', async () => {
    const a = fakeDb(); expect(await req(a, {}, null)).toEqual({ ok: false, status: 409, error: 'SALESNAV_ACCOUNT_NOT_LINKED' });
    const b = fakeDb(); expect(await req(b, {}, 'unreadable')).toEqual({ ok: false, status: 503, error: 'SENDER_ACCOUNT_UNREADABLE' });
    expect(a.inserted.length + b.inserted.length).toBe(0);
  });

  it('a second request while one is pending or approved is refused, not duplicated', async () => {
    for (const status of ['pending', 'approved']) {
      const db = fakeDb({ actions: [{ id: 'old', organization_id: ORG, dm_lead_id: LEAD, acting_user_id: USER, status }] });
      expect(await req(db)).toEqual({ ok: false, status: 409, error: 'MESSAGE_ALREADY_PENDING' });
    }
    const done = fakeDb({ actions: [{ id: 'old', organization_id: ORG, dm_lead_id: LEAD, acting_user_id: USER, status: 'executed' }] });
    expect((await req(done)).ok).toBe(true);
  });

  it('message text: required, at most 8000 characters; line breaks kept', async () => {
    expect(await req(fakeDb(), { text: '   ' })).toEqual({ ok: false, status: 400, error: 'MESSAGE_REQUIRED' });
    expect(await req(fakeDb(), { text: 'x'.repeat(8001) })).toEqual({ ok: false, status: 400, error: 'MESSAGE_TOO_LONG' });
    const db = fakeDb();
    await req(db, { text: 'Line one\r\nLine two' });
    expect(db.inserted[0].suggested_text).toBe('Line one\nLine two');
  });

  it('canonicalProfileUrl accepts only absolute linkedin.com/in/ links', () => {
    expect(canonicalProfileUrl('https://linkedin.com/in/bob')).toBe('https://www.linkedin.com/in/bob/');
    for (const bad of ['bob', '/in/bob', 'https://www.linkedin.com/sales/lead/x', 'https://evil.com/in/bob', 'https://www.linkedin.com/in/', null]) {
      expect(canonicalProfileUrl(bad)).toBeNull();
    }
  });
});

describe('Message on LinkedIn: the executor', () => {
  const approved = (over: Row = {}) => ({
    id: 'a', tenant_id: ORG, organization_id: ORG, platform: 'linkedin', action_type: 'dm', suggested_text: 'Hello Alice',
    target_id: 'https://www.linkedin.com/in/alice-example/', acting_user_id: USER, dm_lead_id: LEAD, dm_sender_member_id: MEMBER, ...over,
  }) as any;

  it('CONTROL: an approved request becomes ONE start_new_dm step with the recipient, text and sender account', () => {
    expect(buildDmCommandChain(approved())).toEqual([{ action_type: 'start_new_dm', payload: {
      recipientProfileUrl: 'https://www.linkedin.com/in/alice-example/', text: 'Hello Alice', autoSubmit: true, senderMemberId: MEMBER } }]);
  });

  it.each([
    ['a non-/in/ target', { target_id: 'https://www.linkedin.com/messaging/thread/1/' }],
    ['no sender account', { dm_sender_member_id: null }],
    ['no sending user', { acting_user_id: null }],
    ['another platform', { platform: 'instagram' }],
  ])('%s -> no chain at all (never a continuation)', (_l, over) => {
    expect(buildDmCommandChain(approved(over))).toBeNull();
  });

  it('CONTROL: an ordinary LinkedIn DM (no lead) is unchanged - still a continuation', () => {
    const chain = buildDmCommandChain(approved({ dm_lead_id: null, dm_sender_member_id: null, target_id: 'someone' })) ?? [];
    expect(chain.map((s) => s.action_type)).not.toContain('start_new_dm');
    expect(chain[chain.length - 1]?.action_type).toBe('continue_thread');
  });

  it('a request is always executed by browser (never an API token or RPA of the organisation)', async () => {
    expect(await resolveExecutionMode(approved({ execution_mode: 'api' }))).toBe('browser');
    expect(await resolveExecutionMode(approved({ execution_mode: null }))).toBe('browser');
  });
});

describe('sign-in: a product-scoped code is not redeemable without a product (review finding 4)', () => {
  const saved = process.env.AUTH_SECRET;
  beforeAll(() => { process.env.AUTH_SECRET = 'new-dm-test-secret'; });
  afterAll(() => { if (saved === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = saved; });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const svc = () => require('../../services/extensionClaimCodeService') as typeof import('../../services/extensionClaimCodeService');

  it('a Sales Navigator code is NOT taken by a pre-split extension (no product) and stays redeemable by Sales Navigator', async () => {
    const db = claimCodeTableFake();
    const c = await svc().createClaimCode('u', 'o', 'salesnav', { table: db.table });
    expect(await svc().redeemClaimCode(c.code, {}, { table: db.table })).toBeNull();
    expect(await svc().redeemClaimCode(c.code, { product: 'salesnav' }, { table: db.table })).toMatchObject({ userId: 'u', product: 'salesnav' });
  });

  it('CONTROL: a pre-split engagement page code (no product) still pairs a pre-split extension', async () => {
    const db = claimCodeTableFake();
    const c = await svc().createClaimCode('u', 'o', null, { table: db.table });
    expect(await svc().redeemClaimCode(c.code, {}, { table: db.table })).toMatchObject({ userId: 'u', product: null });
  });
});

describe('Sales Navigator page: which extension answered, and no silent company switch (findings 5, 6)', () => {
  function win(reply: Row | null) {
    const t = new EventTarget();
    const w: any = {
      location: { origin: 'https://www.omnivyra.com' },
      addEventListener: t.addEventListener.bind(t), removeEventListener: t.removeEventListener.bind(t),
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (id: any) => clearTimeout(id),
      postMessage() { if (reply) setTimeout(() => t.dispatchEvent(Object.assign(new Event('message'), { data: reply, source: w })), 5); },
    };
    return w;
  }
  it('a reply without product (another / pre-split extension) is ignored -> not_detected', async () => {
    expect(await readSalesNavExtensionState(ORG, win({ type: 'OMNIVYRA_EXTENSION_AUTH_STATE', data: { isAuthenticated: true, orgId: ORG } }), 80))
      .toEqual({ kind: 'not_detected' });
    expect(await readSalesNavExtensionState(ORG, win({ type: 'OMNIVYRA_EXTENSION_AUTH_STATE', product: 'linkedin_engagement', data: { isAuthenticated: true, orgId: ORG } }), 80))
      .toEqual({ kind: 'not_detected' });
  });
  it('CONTROL: the Sales Navigator extension\'s own reply is read', async () => {
    expect(await readSalesNavExtensionState(ORG, win({ type: 'OMNIVYRA_EXTENSION_AUTH_STATE', product: 'salesnav', data: { isAuthenticated: true, orgId: ORG } }), 200))
      .toEqual({ kind: 'signed_in', orgId: ORG });
  });
  it('auto sign-in only when signed out; another company needs a click', () => {
    expect(autoSignInAllowed({ kind: 'signed_out' })).toBe(true);
    expect(autoSignInAllowed({ kind: 'other_company', orgId: 'x' })).toBe(false);
    expect(autoSignInAllowed({ kind: 'signed_in', orgId: ORG })).toBe(false);
    expect(autoSignInAllowed({ kind: 'not_detected' })).toBe(false);
  });
});

describe('Message on LinkedIn: the open-request rule (review N1)', () => {
  it('a concurrent duplicate refused by the database unique index (23505) is MESSAGE_ALREADY_PENDING, not 503', async () => {
    const db = fakeDb();
    const table = (name: string) => {
      const q = db.table(name);
      if (name === 'community_ai_actions') q.insert = async () => ({ error: { code: '23505', message: 'duplicate key' } });
      return q;
    };
    const r = await requestLinkedInNewDm({ organizationId: ORG, userId: USER, prospectId: LEAD, text: 'Hi' },
      { table, memberFor: async () => MEMBER, newId: () => 'a2' });
    expect(r).toEqual({ ok: false, status: 409, error: 'MESSAGE_ALREADY_PENDING' });
  });

  it.each(['dispatched', 'acknowledged', 'executing'])('a request still %s counts as open', async (status) => {
    const db = fakeDb({ actions: [{ id: 'old', organization_id: ORG, dm_lead_id: LEAD, acting_user_id: USER, status }] });
    expect(await req(db)).toEqual({ ok: false, status: 409, error: 'MESSAGE_ALREADY_PENDING' });
  });
});
