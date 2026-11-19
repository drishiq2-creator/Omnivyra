/**
 * THE closed set of PRE-CHARGE refusal codes - one dependency-free module for server AND client code (c6 ruling,
 * 2026-11-19).
 *
 * A code is in this set only if EVERY producer raises it BEFORE any credit hold is placed, so a client may say
 * "nothing was charged" and offer a plain retry. preChargeRefusalCodes.test.ts pins that: each code's producers and
 * their callers are enumerated by name, and each caller's check precedes its callCreditReservation(.
 *
 *   DAILY_LIMIT_UNVERIFIABLE / ORG_CONTROLS_UNVERIFIABLE - orgControlService (preflightCheck), called before the hold
 *     in reserveCreditsForWork and executeWithCredits;
 *   BUDGET_UNVERIFIABLE - costGovernanceService (evaluateCost), called by a route that places no hold.
 *
 * NOT in the set: CREDIT_STATE_UNREADABLE. Its producers (findCreditTransaction, loadCreditHoldSplit) also run on the
 * SETTLE paths - confirm / release / executeWithCredits after the work ran - where a hold exists. Until c6 splits a
 * settle-path code from it (registered), it means "unknown": never claim nothing was charged, never offer a blind retry.
 */

export const PRE_CHARGE_REFUSAL_CODES = Object.freeze([
  'DAILY_LIMIT_UNVERIFIABLE',
  'ORG_CONTROLS_UNVERIFIABLE',
  'BUDGET_UNVERIFIABLE',
] as const);

export type PreChargeRefusalCode = (typeof PRE_CHARGE_REFUSAL_CODES)[number];

export function isPreChargeRefusal(code: unknown): code is PreChargeRefusalCode {
  return typeof code === 'string' && (PRE_CHARGE_REFUSAL_CODES as readonly string[]).includes(code);
}
