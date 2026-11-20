/**
 * hidden_billing_catalog — 20260717 seed rows resolve through the REAL catalog read.
 *
 * c6 2026-11-20 (PL-114, b3: fail closed): this was the seed <-> COMPILED_FALLBACK parity guard. The compiled fallback
 * is DELETED - an unreadable catalog now refuses checkout - so parity with it is moot. The seed is now served AS the
 * catalog rows (parsed from the migration), so every seed entry is driven through readCatalogEntry's kind / enabled /
 * minor->major logic. Also asserts migration idempotency + non-destructiveness (unchanged).
 */

import * as fs from 'fs';
import * as path from 'path';

// The catalog read answers the parsed seed rows (filled in beforeAll).
const mockCatalog: Record<string, Record<string, unknown>> = {};
jest.mock('../../db/supabaseClient', () => {
  const builder: any = {};
  let ref = '';
  builder.select = () => builder;
  builder.eq = (_c: string, v: string) => { ref = v; return builder; };
  builder.maybeSingle = () => Promise.resolve({ data: mockCatalog[ref] ?? null, error: null });
  return { supabase: { from: () => builder } };
});

import { resolveBillingAmount } from '../../services/billing/payments/billingAmountResolver';

const MIGRATION_PATH = path.resolve(
  __dirname, '../../../supabase/migrations/20260717_hidden_billing_catalog.sql',
);

function readMigration(): string {
  expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
  return fs.readFileSync(MIGRATION_PATH, 'utf8');
}

interface SeedRow {
  reference_key: string;
  kind: 'subscription' | 'topup';
  amount_minor: number;
  currency: string;
  enabled: boolean;
}

function unquote(s: string): string {
  return s.trim().replace(/^'/, '').replace(/'$/, '');
}

/** Split a VALUES tuple into top-level comma-separated fields. */
function splitFields(tuple: string): string[] {
  const out: string[] = [];
  let depth = 0, buf = '', inStr = false;
  for (let i = 0; i < tuple.length; i++) {
    const ch = tuple[i];
    if (ch === "'" && tuple[i - 1] !== '\\') inStr = !inStr;
    if (!inStr) {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out.map((f) => f.trim());
}

function parseSeed(sql: string): SeedRow[] {
  // Anchor on the real `VALUES (` keyword — NOT a stray "values" in a comment.
  const m = sql.match(/\bVALUES\b\s*(\([\s\S]*?)ON CONFLICT/i);
  expect(m).not.toBeNull();
  const block = m![1];
  const rows: string[] = [];
  // String-aware row extraction — parens inside an 'internal_label' string
  // (e.g. 'Starter (monthly)') must NOT affect tuple-boundary depth.
  let depth = 0, buf = '', inStr = false;
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (ch === "'" && block[i - 1] !== '\\') { inStr = !inStr; buf += ch; continue; }
    if (!inStr) {
      if (ch === '(') { depth++; if (depth === 1) { buf = ''; continue; } }
      if (ch === ')') { depth--; if (depth === 0) { rows.push(buf); continue; } }
    }
    if (depth >= 1) buf += ch;
  }
  return rows.map((tuple) => {
    const f = splitFields(tuple);
    expect(f).toHaveLength(6); // reference_key, kind, amount_minor, currency, enabled, internal_label
    return {
      reference_key: unquote(f[0]),
      kind: unquote(f[1]) as SeedRow['kind'],
      amount_minor: Number(f[2].trim()),
      currency: unquote(f[3]),
      enabled: f[4].trim().toLowerCase() === 'true',
    };
  });
}

function minorToMajor(minor: number, currency: string): number {
  const zeroDecimal = new Set(['JPY', 'KRW', 'VND', 'CLP', 'XOF', 'XAF']);
  return zeroDecimal.has(currency.toUpperCase()) ? minor : minor / 100;
}

// ── migration idempotency / non-destructiveness ─────────────────────────────

describe('20260717 migration — idempotency', () => {
  test('uses CREATE TABLE IF NOT EXISTS', () => {
    expect(readMigration()).toMatch(/CREATE TABLE IF NOT EXISTS public\.hidden_billing_catalog/i);
  });
  test('seed uses ON CONFLICT (reference_key) DO NOTHING', () => {
    expect(readMigration()).toMatch(/ON CONFLICT \(reference_key\) DO NOTHING/i);
  });
  test('contains no destructive DDL (no DROP / TRUNCATE / DELETE)', () => {
    const sql = readMigration().toUpperCase();
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/);
    expect(sql).not.toMatch(/\bTRUNCATE\b/);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/);
  });
});

// ── seed rows resolve through the real catalog read ─────────────────────────

describe('hidden_billing_catalog — seed rows resolve through the catalog read', () => {
  beforeAll(() => {
    for (const r of parseSeed(readMigration())) {
      mockCatalog[r.reference_key] = { kind: r.kind, amount_minor: r.amount_minor, currency: r.currency, enabled: r.enabled };
    }
  });
  test('the seed registers exactly the six known references', () => {
    const seed = parseSeed(readMigration());
    expect(seed.map((r) => r.reference_key).sort()).toEqual([
      'plan_legacy_v1', 'plan_pro_monthly', 'plan_starter_monthly',
      'topup_credits_2000', 'topup_credits_500', 'topup_legacy_pack',
    ]);
  });

  test('every ENABLED seed entry resolves to the seed amount/currency', async () => {
    for (const entry of parseSeed(readMigration()).filter((r) => r.enabled)) {
      const r = await resolveBillingAmount({ intentType: entry.kind, reference: entry.reference_key });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.amount.currency).toBe(entry.currency);
        expect(r.amount.amount).toBe(minorToMajor(entry.amount_minor, entry.currency));
      }
    }
  });

  test('every DISABLED seed entry is rejected (disabled_reference)', async () => {
    for (const entry of parseSeed(readMigration()).filter((r) => !r.enabled)) {
      const r = await resolveBillingAmount({ intentType: entry.kind, reference: entry.reference_key });
      expect(r.ok).toBe(false);
      if (r.ok === false) expect(r.code).toBe('disabled_reference');
    }
  });

  test('a seed entry resolved with the WRONG kind is rejected (kind integrity)', async () => {
    const seed = parseSeed(readMigration());
    const sub = seed.find((r) => r.kind === 'subscription' && r.enabled)!;
    const r = await resolveBillingAmount({ intentType: 'topup', reference: sub.reference_key });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.code).toBe('unknown_reference');
  });
});
