/**
 * 04 (2026-11-20; c6 handover, money). Provider-invoice reconciliation must not reconcile against a read that FAILED.
 *
 * Before: each reconciler answered a failed usage_events read (stripe: credit_purchases / payment_transactions /
 * billing_subscriptions) with [] after a warn, so it wrote APPEND-ONLY cost_reconciliation_adjustments attributing the
 * whole invoice as unaccounted. The read also ran AFTER the provider_invoice_imports insert (the idempotency marker),
 * so a retry answered 'duplicate' and the period could never be redone.
 * Now: the read happens BEFORE the marker and a failure throws ReconciliationReadError. Nothing is written, and a retry
 * runs. Control: a read that SUCCEEDS with zero rows is a legitimate empty period and ingests.
 */
let failTable: string | null = null;
const writes: Array<{ table: string; op: string }> = [];
const READ_TABLES = new Set(['usage_events', 'credit_purchases', 'payment_transactions', 'billing_subscriptions']);

jest.mock('../../db/supabaseClient', () => {
  const from = (table: string) => {
    const b: any = {};
    for (const m of ['select', 'eq', 'gte', 'lt', 'lte', 'or', 'in', 'like', 'ilike', 'not', 'order', 'limit']) b[m] = () => b;
    b.insert = () => { writes.push({ table, op: 'insert' }); return b; };
    b.upsert = () => { writes.push({ table, op: 'upsert' }); return b; };
    b.single = () => Promise.resolve({ data: { id: 'run-1' }, error: null });
    b.maybeSingle = b.single;
    b.then = (res: any, rej: any) => {
      const failed = READ_TABLES.has(table) && failTable === table;
      return Promise.resolve({ data: failed ? null : [], error: failed ? { code: '08006', message: 'connection reset' } : null }).then(res, rej);
    };
    return b;
  };
  return { supabase: { from } };
});
jest.mock('../../services/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { ingestAnthropicInvoice } from '../../services/billing/reconciliation/anthropicReconciler';
import { ingestGeminiInvoice } from '../../services/billing/reconciliation/geminiReconciler';
import { ingestOpenAiInvoice } from '../../services/billing/reconciliation/openaiReconciler';
import { ingestAudioInvoice } from '../../services/billing/reconciliation/audioReconciler';
import { ingestImageInvoice } from '../../services/billing/reconciliation/imageReconciler';
import { ingestStripeInvoice } from '../../services/billing/reconciliation/stripeReconciler';
import { ReconciliationReadError } from '../../services/billing/reconciliation/reconciliationReadError';

const BASE = { providerInvoiceId: 'inv-1', periodStart: '2026-10-01T00:00:00Z', periodEnd: '2026-11-01T00:00:00Z', payload: {}, rates: {} as any };
type Case = [string, string, () => Promise<unknown>];
const CASES: Case[] = [
  ['anthropic', 'usage_events', () => ingestAnthropicInvoice({ ...BASE, kind: 'billing' })],
  ['gemini', 'usage_events', () => ingestGeminiInvoice({ ...BASE, kind: 'gcb_export' })],
  ['openai', 'usage_events', () => ingestOpenAiInvoice({ ...BASE })],
  ['audio', 'usage_events', () => ingestAudioInvoice({ ...BASE, providerTag: 'openai_audio', kind: 'billing' })],
  ['image', 'usage_events', () => ingestImageInvoice({ ...BASE, providerTag: 'openai_image', kind: 'billing' })],
  ['stripe', 'credit_purchases', () => ingestStripeInvoice({ ...BASE, kind: 'balance' })],
  ['stripe', 'payment_transactions', () => ingestStripeInvoice({ ...BASE, kind: 'balance' })],
  ['stripe', 'billing_subscriptions', () => ingestStripeInvoice({ ...BASE, kind: 'balance' })],
];

beforeEach(() => { failTable = null; writes.length = 0; });

describe('a FAILED read throws before the idempotency marker; nothing is written', () => {
  it.each(CASES)('%s: %s read fails → ReconciliationReadError, no marker, no run, no adjustments', async (_p, table, run) => {
    failTable = table;
    await expect(run()).rejects.toBeInstanceOf(ReconciliationReadError);
    await expect(run()).rejects.toMatchObject({ code: 'RECONCILIATION_READ_FAILED', table });
    expect(writes).toEqual([]);
  });

  it.each(CASES)('%s (%s): after the read recovers, the retry RUNS (no stale marker answering "duplicate")', async (_p, table, run) => {
    failTable = table;
    await run().catch(() => undefined);
    failTable = null;
    const out = (await run()) as { status: string };
    expect(out.status).toBe('ingested');
    expect(writes.some((w) => w.table === 'provider_invoice_imports')).toBe(true);
  });
});

describe('control: a read that SUCCEEDS with zero rows is a legitimate empty period', () => {
  it.each(CASES.filter((c, i, a) => a.findIndex((d) => d[0] === c[0]) === i))('%s ingests on an empty, successful read', async (_p, _t, run) => {
    const out = (await run()) as { status: string };
    expect(out.status).toBe('ingested');
    expect(writes[0]).toEqual({ table: 'provider_invoice_imports', op: 'insert' });
  });
});
