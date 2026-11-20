/**
 * 20270217000053 is GENERATED from the LIVE prod bodies (scripts/migrations/gen-053-credit-settle-guards.py). This pins
 * the two properties e9/05 required, structurally (the behaviour is proven against Postgres in
 * backend/tests/realschema/credit_settle_guards_053.test.ts):
 *   1. NOTHING LIVE IS LOST: every line of each live body appears, IN ORDER, in the 053 body - except exactly the lines
 *      053 replaces (the hold-availability double-subtract and the catch-all unique_violation handler).
 *   2. Every guard is present, and the bodies the migration pins by md5 are the ones in the file.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = process.cwd();
const FIX = path.join(ROOT, 'backend/tests/fixtures/live-credit-functions-20261113');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20270217000053_credit_settle_guards_reauthor.sql'), 'utf8');
const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
const crlf = (s: string) => s.replace(/\n/g, '\r\n');

/** Body of `CREATE OR REPLACE FUNCTION public.<name>(...) ... AS $fn$<body>$fn$`. */
function body(name: string): string {
  const at = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(at).toBeGreaterThanOrEqual(0);
  const open = SQL.indexOf('$fn$', at) + 4;
  return SQL.slice(open, SQL.indexOf('$fn$', open));
}
const RES = body('apply_credit_reservation');
const PC = body('apply_credit_partial_confirm');
const LIVE_RES = fs.readFileSync(path.join(FIX, 'LIVE-apply_credit_reservation.prosrc.sql'), 'utf8');
const LIVE_PC = fs.readFileSync(path.join(FIX, 'LIVE-apply_credit_partial_confirm.prosrc.sql'), 'utf8');

/** The live lines that 053 deliberately replaces (and nothing else). */
const REPLACED = [
  /v_avail_(free|incentive|paid)\s*:= GREATEST\(0, v_wallet\.\w+_balance\s*- v_wallet\.reserved_\w+\);/,
];

function missingLiveLines(live: string, next: string): string[] {
  const nextLines = next.split('\n');
  const missing: string[] = [];
  let j = 0;
  for (const line of live.split('\n')) {
    if (REPLACED.some((re) => re.test(line))) continue;
    let k = j;
    while (k < nextLines.length && nextLines[k] !== line) k++;
    if (k === nextLines.length) missing.push(line); else j = k + 1;
  }
  return missing;
}

it('the fixtures are the prod bodies', () => {
  expect(md5(LIVE_RES)).toBe('ad5383bf6ccf24a2c8ddee70db3b1297');
  expect(md5(LIVE_PC)).toBe('ff208f60617a7a272305a804037bf47d');
});

it('apply_credit_reservation: every live line survives, in order (only the double-subtract lines are replaced)', () => {
  expect(missingLiveLines(LIVE_RES, RES)).toEqual([]);
});

it('apply_credit_partial_confirm: every live line survives, in order', () => {
  expect(missingLiveLines(LIVE_PC, PC)).toEqual([]);
});

it('positive control: the subsequence check DOES catch a dropped live line', () => {
  const dropped = RES.replace('lifetime_consumed = lifetime_consumed + p_free_amount + p_incentive_amount + p_paid_amount,', '');
  expect(missingLiveLines(LIVE_RES, dropped).length).toBeGreaterThan(0);
});

it('the md5 the postcondition pins is the md5 of the bodies in this file (LF or CRLF)', () => {
  expect(SQL).toContain(`NOT IN ('${md5(RES)}', '${md5(crlf(RES))}')`);
  expect(SQL).toContain(`NOT IN ('${md5(PC)}', '${md5(crlf(PC))}')`);
});

// ── preflight allowlist (7c/cb 2026-11-20): md5 only, every constant DERIVED from a committed text ─────────────────
const R625 = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260625_monetization_invariant_hardening.sql'), 'utf8');
const B625 = [...R625.matchAll(/AS \$\$([\s\S]*?)\$\$;/g)].map((m) => m[1]);
/** 20270217000001 single_count's patch, re-derived here independently of the generator. */
const scLive = (b: string) => b
  .replace('GREATEST(0, v_wallet.free_balance      - v_wallet.reserved_free)', 'GREATEST(0, v_wallet.free_balance)')
  .replace('GREATEST(0, v_wallet.incentive_balance - v_wallet.reserved_incentive)', 'GREATEST(0, v_wallet.incentive_balance)')
  .replace('GREATEST(0, v_wallet.paid_balance      - v_wallet.reserved_paid)', 'GREATEST(0, v_wallet.paid_balance)');
const sc625 = (b: string) => b.split('(v_wallet.free_balance - v_wallet.reserved_free)').join('v_wallet.free_balance')
  .split('(v_wallet.incentive_balance - v_wallet.reserved_incentive)').join('v_wallet.incentive_balance')
  .split('(v_wallet.paid_balance - v_wallet.reserved_paid)').join('v_wallet.paid_balance');
const both = (...bs: string[]) => bs.flatMap((b) => [md5(b), md5(crlf(b))]);
/** The md5 list of the `IF md5(<v>) NOT IN (...)` preflight clause for one function. */
function allowlist(v: string): string[] {
  const m = SQL.match(new RegExp(`IF md5\\(${v}\\) NOT IN \\(([^)]*)\\) THEN`));
  expect(m).not.toBeNull();
  return [...m![1].matchAll(/'([0-9a-f]{32})'/g)].map((x) => x[1]);
}

it('the derivation inputs are the bodies 000001 and the replay pin (checkpoints, so a drift is loud)', () => {
  expect(B625).toHaveLength(3);
  expect(md5(B625[1])).toBe('c62d8dde5e3ad20a22ad6fd8ccc77154');
  expect(md5(B625[2])).toBe('9591e6b38a79e6cfb02f60f19075f140');
  // 20270217000001's own constants (its header): prod ad5383bf -> 03d616e6 / CRLF 1db00c4d -> 90bcbfb5; 20260625 c62d8dde -> 7799ec27.
  expect([md5(scLive(LIVE_RES)), md5(crlf(scLive(LIVE_RES)))]).toEqual(['03d616e692cdfb9fefc25eb81e8e4595', '90bcbfb5e9eb2eedf1a0b7a8266554bf']);
  expect(md5(crlf(LIVE_RES))).toBe('1db00c4d06a4a16c84ed419c4cc47bf6');
  expect([md5(sc625(B625[1])), md5(crlf(sc625(B625[1])))]).toEqual(['7799ec2755c49c952bacd529916acc9c', '7ee214ad28938b36d57f63eb68a9b9cd']);
});

it('apply_credit_reservation preflight allowlist = EXACTLY prod, prod+000001, 20260625, 20260625+000001, 053 (each LF+CRLF)', () => {
  expect(allowlist('v_res').sort()).toEqual(both(LIVE_RES, scLive(LIVE_RES), B625[1], sc625(B625[1]), RES).sort());
});

it('apply_credit_partial_confirm preflight allowlist = EXACTLY prod, 20260625, 053 (each LF+CRLF)', () => {
  expect(allowlist('v_pc').sort()).toEqual(both(LIVE_PC, B625[2], PC).sort());
});

it('control: an allowlist missing one derived CRLF form is caught', () => {
  const short = allowlist('v_res').filter((m) => m !== md5(crlf(scLive(LIVE_RES))));
  expect(short.sort()).not.toEqual(both(LIVE_RES, scLive(LIVE_RES), B625[1], sc625(B625[1]), RES).sort());
});

it('the capture list is the class-1 set (the 053 outputs are NOT captured as pre-images)', () => {
  const cap = SQL.slice(SQL.indexOf('DO $capture$'), SQL.indexOf('$capture$;'));
  const lists = [...cap.matchAll(/ARRAY\[([^\]]*)\]/g)].map((m) => [...m[1].matchAll(/'([0-9a-f]{32})'/g)].map((x) => x[1]).sort());
  expect(lists).toEqual([
    both(LIVE_RES, scLive(LIVE_RES), B625[1], sc625(B625[1])).sort(),
    both(LIVE_PC, B625[2]).sort(),
  ]);
});

it('no substring acceptance and no "already applied" short-circuit remain; prosecdef stays pinned', () => {
  expect(SQL).not.toMatch(/position\('already settled by'/);
  // no early exit anywhere outside the function bodies (a re-run executes every idempotent statement)
  for (const tag of ['$preflight$', '$capture$', '$verify$']) {
    const blk = SQL.slice(SQL.indexOf(`DO ${tag}`), SQL.indexOf(`${tag};`));
    expect(blk.length).toBeGreaterThan(100);
    expect(blk).not.toMatch(/\bRETURN\b/);
  }
  expect(SQL).toContain("RAISE EXCEPTION '053 postcondition: a credit function became SECURITY DEFINER");
});

it.each([
  ['CREDIT_AMOUNT_NULL', RES], ['CREDIT_AMOUNT_NEGATIVE', RES], ['CREDIT_IDEMPOTENCY_KEY_REQUIRED', RES],
  ['SETTLE_REQUIRES_PARENT_HOLD', RES], ['SETTLE_PARENT_NOT_A_HOLD', RES], ['HOLD_ALREADY_SETTLED', RES],
  ['SETTLE_EXCEEDS_HOLD', RES], ['SETTLE_EXCEEDS_RESERVED', RES], ['PARENT_ONLY_FOR_SETTLE', RES],
  ['CREDIT_IDEMPOTENCY_COLLISION_WITHOUT_ROW', RES],
  ['CREDIT_AMOUNT_NULL', PC], ['CREDIT_AMOUNT_NEGATIVE', PC], ['CREDIT_IDEMPOTENCY_KEY_REQUIRED', PC],
  ['HOLD_ALREADY_SETTLED', PC], ['CREDIT_IDEMPOTENCY_COLLISION_WITHOUT_ROW', PC],
])('guard %s is present', (code, b) => {
  expect(b).toContain(code);
});

it('the already-settled check recognises every settle phase, including the live confirm_partial', () => {
  for (const b of [RES, PC]) expect(b).toContain("execution_phase IN ('confirm', 'confirm_partial', 'release')");
});

it('the unique_violation handler re-raises anything that is not the idempotency key', () => {
  for (const b of [RES, PC]) {
    expect(b).toMatch(/GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;\s*IF v_constraint IS NULL OR v_constraint NOT IN \(/);
    expect(b).toMatch(/THEN\s*RAISE;\s*END IF;/);
  }
});
