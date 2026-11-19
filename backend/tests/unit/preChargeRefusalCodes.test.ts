/**
 * The closed PRE-CHARGE refusal set (shared/billing/preChargeRefusalCodes, c6 ruling 2026-11-19): a code is in it only
 * if EVERY producer raises it BEFORE any credit hold. Pinned by CONTENT, never by line (a line-keyed guard breaks on
 * any commit that moves the line - 7c):
 *   1. the set, by name;
 *   2. each code's producers, enumerated across the source tree by name (a new producer fails here and must be traced);
 *   3. each producer's callers, by name;
 *   4. in each caller, the check precedes callCreditReservation( (or the caller places no hold at all).
 * CREDIT_STATE_UNREADABLE is deliberately OUT: its producers also run on the settle paths, after the work ran.
 */
import fs from 'fs';
import path from 'path';
import {
  PRE_CHARGE_REFUSAL_CODES,
  isPreChargeRefusal,
  type PreChargeRefusalCode,
} from '../../../shared/billing/preChargeRefusalCodes';
import type { StateUnreadableCode } from '../../services/creditExecutionServiceContracts';

const ROOT = path.resolve(__dirname, '../../..');
const SCAN = ['backend', 'pages', 'lib', 'shared', 'components', 'hooks'];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (path.relative(ROOT, p).split(path.sep).join('/') === 'backend/tests') continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) {
        out.push(path.relative(ROOT, p).split(path.sep).join('/'));
      }
    }
  };
  for (const d of SCAN) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  return out;
}
const FILES = sourceFiles();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const filesMatching = (re: RegExp, except: string[] = []) => FILES.filter((f) => !except.includes(f) && re.test(read(f))).sort();

const MODULE = 'shared/billing/preChargeRefusalCodes.ts';
const CONTRACTS = 'backend/services/creditExecutionServiceContracts.ts';
const RUNTIME_CORE = 'backend/services/creditExecutionServiceRuntimeCore.ts';
const ORG = 'backend/services/orgControlService.ts';
const COST = 'backend/services/costGovernanceService.ts';
const COST_ROUTE = 'pages/api/active-leads/cost-governance.ts';

/** The body of `export async function <name>` up to the next top-level `export `. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  if (start < 0) return '';
  const next = src.indexOf('\nexport ', start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}
/** True when `check` appears in the body and precedes the first callCreditReservation( (if any). */
function checkPrecedesHold(body: string, check: string): boolean {
  const c = body.indexOf(check);
  const h = body.indexOf('callCreditReservation(');
  return c >= 0 && (h < 0 || c < h);
}

it('POSITIVE CONTROL: the scan sees the tree (hundreds of files, and a known producer of a known code)', () => {
  expect(FILES.length).toBeGreaterThan(300);
  expect(filesMatching(/'CREDIT_STATE_UNREADABLE'/)).toContain('backend/repositories/creditExecutionRepository.ts');
});

it('the set is exactly the three pre-charge codes', () => {
  expect([...PRE_CHARGE_REFUSAL_CODES]).toEqual(['DAILY_LIMIT_UNVERIFIABLE', 'ORG_CONTROLS_UNVERIFIABLE', 'BUDGET_UNVERIFIABLE']);
  expect(Object.isFrozen(PRE_CHARGE_REFUSAL_CODES)).toBe(true);
});

it('isPreChargeRefusal: true for the set; FALSE for CREDIT_STATE_UNREADABLE (settle paths raise it) and junk', () => {
  for (const c of PRE_CHARGE_REFUSAL_CODES) expect(isPreChargeRefusal(c)).toBe(true);
  for (const c of ['CREDIT_STATE_UNREADABLE', 'QUEUE_LOCK_STATE_UNREADABLE', '', null, undefined, 42, {}]) {
    expect(isPreChargeRefusal(c)).toBe(false);
  }
});

it.each([
  ['DAILY_LIMIT_UNVERIFIABLE', [ORG]],
  ['ORG_CONTROLS_UNVERIFIABLE', [ORG]],
  ['BUDGET_UNVERIFIABLE', [COST]],
])('%s: produced ONLY by %j (a new producer must be traced before it can stay in the set)', (code, producers) => {
  // The module itself and the derived StateUnreadableCode type name the codes without producing them.
  expect(filesMatching(new RegExp(`'${code}'`), [MODULE, CONTRACTS])).toEqual(producers);
});

it('the producers\' entry points are called ONLY by the known callers', () => {
  expect(filesMatching(/\bpreflightCheck\(/, [ORG])).toEqual([CONTRACTS, RUNTIME_CORE].sort());
  expect(filesMatching(/\bevaluateCost\(/, [COST])).toEqual([COST_ROUTE]);
});

it('every caller raises the check BEFORE any hold', () => {
  expect(checkPrecedesHold(functionBody(read(CONTRACTS), 'reserveCreditsForWork'), 'preflightCheck(')).toBe(true);
  expect(checkPrecedesHold(functionBody(read(RUNTIME_CORE), 'executeWithCredits'), 'preflightCheck(')).toBe(true);
  // The bodies were found (an empty body would make the order check meaningless) and do place a hold.
  expect(functionBody(read(CONTRACTS), 'reserveCreditsForWork')).toContain('callCreditReservation(');
  expect(functionBody(read(RUNTIME_CORE), 'executeWithCredits')).toContain('callCreditReservation(');
  // The budget route places no hold at all.
  expect(read(COST_ROUTE)).not.toMatch(/callCreditReservation\(|reserveCreditsForWork\(|apply_credit_reservation/);
});

it('POSITIVE CONTROL: the order check fails when the hold comes first, or the check is missing', () => {
  expect(checkPrecedesHold('a(); callCreditReservation({}); preflightCheck(o, c);', 'preflightCheck(')).toBe(false);
  expect(checkPrecedesHold('callCreditReservation({});', 'preflightCheck(')).toBe(false);
  expect(checkPrecedesHold('preflightCheck(o, c); callCreditReservation({});', 'preflightCheck(')).toBe(true);
});

// Type-level pin (tsc; ts-jest is transpile-only): StateUnreadableCode keeps EXACTLY its three members - derived from
// the set, plus CREDIT_STATE_UNREADABLE, minus BUDGET_UNVERIFIABLE (no credit-execution producer returns it).
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const stateUnreadableMembers: Equal<
  StateUnreadableCode,
  'CREDIT_STATE_UNREADABLE' | 'DAILY_LIMIT_UNVERIFIABLE' | 'ORG_CONTROLS_UNVERIFIABLE'
> = true;
const budgetIsPreCharge: Equal<Extract<PreChargeRefusalCode, 'BUDGET_UNVERIFIABLE'>, 'BUDGET_UNVERIFIABLE'> = true;
it('StateUnreadableCode keeps exactly its three members (type-level, checked by tsc)', () => {
  expect([stateUnreadableMembers, budgetIsPreCharge]).toEqual([true, true]);
});
