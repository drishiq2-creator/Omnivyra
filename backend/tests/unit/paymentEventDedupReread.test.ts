/**
 * Reads contract A6 (e9 BLOCKING; e1 approved the hunk list): recordPaymentProviderEvent's re-read after a 23505.
 * Before: `{ data }` only -> a FAILED re-read (or no row at all) returned { id: null, duplicate: true,
 * processingStatus: null } -> the processed-duplicate refusal was skipped and fulfilment re-ran. Now both throw the
 * typed retryable PaymentEventStateUnreadableError (the webhook answers 5xx; the provider redelivers).
 * The fake mirrors PostgREST: insert().select().maybeSingle() and select().eq().eq().maybeSingle() resolve
 * { data, error } and never throw.
 */
type Res = { data: unknown; error: { code?: string; message: string } | null };
const db: { insert: Res; reread: Res; rereadFilters: Array<[string, unknown]> } = {
  insert: { data: null, error: null }, reread: { data: null, error: null }, rereadFilters: [],
};

jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: (table: string) => {
    if (table !== 'payment_provider_events') throw new Error(`unexpected table ${table}`);
    let mode: 'insert' | 'reread' = 'reread';
    const b: any = {};
    b.insert = () => { mode = 'insert'; return b; };
    b.select = () => b;
    b.eq = (c: string, v: unknown) => { db.rereadFilters.push([c, v]); return b; };
    b.maybeSingle = async () => (mode === 'insert' ? db.insert : db.reread);
    return b;
  },
}));
jest.mock('../../services/creditExecutionService', () => ({ createCredit: jest.fn(), makeIdempotencyKey: jest.fn() }));
jest.mock('../../services/requestContext', () => ({ getRequestContext: () => ({}) }));

/* eslint-disable @typescript-eslint/no-var-requires */
const { recordPaymentProviderEvent, PaymentEventStateUnreadableError } = require('../../services/purchaseService');
/* eslint-enable @typescript-eslint/no-var-requires */

const EVT = { provider: 'razorpay', providerEventId: 'evt_1', eventType: 'payment.captured' };
const DUP = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };

beforeEach(() => { db.insert = { data: null, error: null }; db.reread = { data: null, error: null }; db.rereadFilters = []; });

it('23505 + the re-read FAILS -> throws the typed retryable error (not a status-less duplicate)', async () => {
  db.insert = DUP;
  db.reread = { data: null, error: { message: 'connection reset' } };
  const p = recordPaymentProviderEvent(EVT);
  await expect(p).rejects.toBeInstanceOf(PaymentEventStateUnreadableError);
  await expect(p).rejects.toMatchObject({ code: 'PAYMENT_EVENT_UNREADABLE', retryable: true });
  await expect(p).rejects.toThrow(/re-read after 23505 failed: connection reset/);
});

it('23505 + the re-read returns NO row (no error) -> throws: an impossible state, not "new" or "duplicate"', async () => {
  db.insert = DUP;
  db.reread = { data: null, error: null };
  await expect(recordPaymentProviderEvent(EVT)).rejects.toThrow(/23505 on insert but the re-read found no row/);
});

it('CONTROL: 23505 + a readable row -> the existing duplicate answer with its status (re-read keyed on provider + event id)', async () => {
  db.insert = DUP;
  db.reread = { data: { id: 'ppe-1', processing_status: 'processed' }, error: null };
  await expect(recordPaymentProviderEvent(EVT)).resolves.toEqual({ id: 'ppe-1', duplicate: true, processingStatus: 'processed' });
  expect(db.rereadFilters).toEqual([['provider', 'razorpay'], ['provider_event_id', 'evt_1']]);
});

it('CONTROL: a fresh insert -> not a duplicate, no re-read', async () => {
  db.insert = { data: { id: 'ppe-2', processing_status: 'received' }, error: null };
  await expect(recordPaymentProviderEvent(EVT)).resolves.toEqual({ id: 'ppe-2', duplicate: false, processingStatus: 'received' });
  expect(db.rereadFilters).toEqual([]);
});

it('CONTROL: a non-23505 insert error still throws the existing untyped error', async () => {
  db.insert = { data: null, error: { code: '42501', message: 'permission denied' } };
  const p = recordPaymentProviderEvent(EVT);
  await expect(p).rejects.toThrow(/payment event record failed: permission denied/);
  await expect(p).rejects.not.toMatchObject({ name: 'PaymentEventStateUnreadableError' });
});
