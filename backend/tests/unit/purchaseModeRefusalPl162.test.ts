/**
 * PL-162 (owner ruling 2026-11-20 via b3; cb register; 7c NB1/NB2 on 49dc69916):
 *  1. a refused non-live purchase is named by its STORED mode ('test' / 'manual' / anything else), never all "test";
 *  2. every credit_purchases insert states provider_mode, so the column DEFAULT ('manual') never decides;
 *  3. "is this live?" has ONE definition (liveProviderMode.ts) and every caller imports it.
 */
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  NON_LIVE_PURCHASE_NOT_GRANTABLE, OFFLINE_PURCHASE_NO_AUTO_CREDIT, OFFLINE_PURCHASE_NO_AUTO_CREDIT_MESSAGE,
  TEST_MODE_PAYMENT_NO_CREDITS, nonLivePurchaseRefusal,
} from '../../../shared/billing/purchaseModeRefusal';

const ROOT = join(__dirname, '../../..');
const tracked = (): string[] => execSync('git ls-files -- backend pages lib shared', { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => /\.(ts|tsx)$/.test(f) && !/(^|\/)(tests|__tests__)\/|\.test\.|\.spec\./.test(f));

describe('1. nonLivePurchaseRefusal: one code per stored mode', () => {
  it.each<[unknown, string, string]>([
    ['test', TEST_MODE_PAYMENT_NO_CREDITS, 'test_mode_payment_no_grant'],
    ['manual', OFFLINE_PURCHASE_NO_AUTO_CREDIT, 'offline_purchase_no_auto_credit'],
  ])('%s → %s', (mode, code, recorded) => {
    expect(nonLivePurchaseRefusal(mode)).toMatchObject({ code, fulfillmentError: recorded });
  });
  it('the offline copy is the owner\'s wording, and never says "test"', () => {
    expect(nonLivePurchaseRefusal('manual').message).toBe(OFFLINE_PURCHASE_NO_AUTO_CREDIT_MESSAGE);
    expect(OFFLINE_PURCHASE_NO_AUTO_CREDIT_MESSAGE).toBe("Offline purchases don't add credits automatically: grant them in Usage → Credits → Grant Credits.");
    expect(OFFLINE_PURCHASE_NO_AUTO_CREDIT_MESSAGE).not.toMatch(/test/i);
  });
  it.each<[string, unknown]>([
    ['NULL', null], ['undefined', undefined], ['empty', ''], ["'unknown'", 'unknown'], ["'sandbox'", 'sandbox'],
    ["'TEST' (casing)", 'TEST'], ["'Manual' (casing)", 'Manual'], ["' manual' (whitespace)", ' manual'], ['a number', 1],
  ])('%s → the generic NON_LIVE code (exact matches only, never a guess)', (_n, mode) => {
    expect(nonLivePurchaseRefusal(mode)).toMatchObject({ code: NON_LIVE_PURCHASE_NOT_GRANTABLE, fulfillmentError: 'non_live_payment_no_grant' });
  });
});

/** Every credit_purchases INSERT/UPSERT in a source text, and whether its payload names provider_mode. */
function insertSites(src: string): Array<{ index: number; namesMode: boolean }> {
  const out: Array<{ index: number; namesMode: boolean }> = [];
  const handle = /(from|ownedDbTable)\(\s*['"]credit_purchases['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = handle.exec(src))) {
    const rest = src.slice(m.index + m[0].length, m.index + m[0].length + 200);
    const op = /^[\s\S]{0,120}?\.(insert|upsert)\(/.exec(rest);
    if (!op) continue;
    let i = m.index + m[0].length + op.index + op[0].length; let depth = 1; const start = i;
    while (i < src.length && depth > 0) { if (src[i] === '(') depth++; else if (src[i] === ')') depth--; i++; }
    out.push({ index: m.index, namesMode: /\bprovider_mode\b/.test(src.slice(start, i - 1)) });
  }
  return out;
}

describe('2. every credit_purchases insert states provider_mode', () => {
  const sites = tracked().flatMap((f) => insertSites(readFileSync(join(ROOT, f), 'utf8')).map((s) => ({ file: f, ...s })));

  it('COUNT CONTROL: the scan finds the known insert sites (create-order, razorpay staging, super-admin create)', () => {
    expect(sites.map((s) => s.file).sort()).toEqual([
      'backend/services/payments/razorpayStagingService.ts',
      'pages/api/billing/checkout/create-order.ts',
      'pages/api/super-admin/purchases/complete.ts',
    ]);
  });
  it('none omits provider_mode', () => {
    expect(sites.filter((s) => !s.namesMode)).toEqual([]);
  });
  it('NEGATIVE CONTROL: an insert without provider_mode IS flagged (the scan can fail)', () => {
    const fixture = `await supabase.from('credit_purchases').insert({ organization_id, credits, status: 'pending' }).select('id');`;
    expect(insertSites(fixture)).toEqual([{ index: expect.any(Number), namesMode: false }]);
    const ok = `await ownedDbTable('credit_purchases').insert({ provider_mode: 'live', organization_id });`;
    expect(insertSites(ok)).toEqual([{ index: expect.any(Number), namesMode: true }]);
  });
});

describe('3. "is this live?" has one definition (7c NB2)', () => {
  const files = tracked();
  it('exactly one liveProviderMode.ts exists', () => {
    expect(files.filter((f) => /(^|\/)liveProviderMode\.ts$/.test(f))).toEqual(['backend/services/billing/liveProviderMode.ts']);
  });
  it('every importer of isLiveProviderMode imports it from that file, and no one redefines it', () => {
    const importers: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      if (!/\bisLiveProviderMode\b/.test(src) || f === 'backend/services/billing/liveProviderMode.ts') continue;
      importers.push(f);
      expect(src).toMatch(/import \{[^}]*\bisLiveProviderMode\b[^}]*\} from '[^']*\/liveProviderMode'/);
      expect(src).not.toMatch(/function isLiveProviderMode|const isLiveProviderMode/);
    }
    expect(importers.length).toBeGreaterThanOrEqual(1); // non-vacuity: purchaseService on main
  });
});
