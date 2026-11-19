/**
 * Market Pulse credit notices (55's charging, afb199ca9 + 650a0ac8b; 2026-11-13).
 *
 * - POST /api/market-pulse/run can return 402 before any job is created:
 *   { error: 'insufficient_credits' | 'no_credit_account' | 'pricing_unavailable',
 *     message, required?, available?, perRegion? }.
 *   The user sees the plain `message` (never the raw code) and a link to top up.
 * - A run that stops part-way ends as completed_with_warnings; the banner says so in general terms.
 *   (2026-11-19, b3: the per-region list and its codes INSUFFICIENT_CREDITS / CHARGED_NO_OUTPUT /
 *   ALREADY_RELEASED were removed as dormant. Their only producer was the superseded C75 line
 *   (97d74d08b, run.region_issues); the canonical Market Pulse billing charges a region only after its
 *   results are saved and exposes no per-region outcome, so nothing could ever fill the list. If the
 *   server later exposes per-region outcomes, map them from THAT producer's vocabulary.)
 *
 * The top-up target is /company/billing, the same page the credit-alert and
 * consumption-warning emails link to (creditAlertService.ts, creditConsumptionWarningService.ts).
 */
import React from 'react';
import Link from 'next/link';

import { TOP_UP_HREF, classifyBilledResponse } from '../../../lib/billing/billedResponse';

// The canonical billed-response mapping lives in lib/billing/billedResponse (e9 ruling);
// Market Pulse is one of its callers. Re-exported so existing imports keep working.
export { TOP_UP_HREF };

export type CreditNotice = {
  kind: 'credits';
  code: string;
  message: string;
  required?: number;
  available?: number;
};

export type RunStartError = CreditNotice | { kind: 'error'; message: string };

/** Scan-specific wording when the server sends no message. */
const SCAN_CREDIT_FALLBACK: Record<string, string> = {
  insufficient_credits: 'You don’t have enough credits to run this scan.',
  no_credit_account: 'Your company doesn’t have a credit account yet.',
  pricing_unavailable: 'Scan pricing is temporarily unavailable, so the scan wasn’t started. Please try again shortly.',
};

/** Map a failed POST /api/market-pulse/run response to what the user should see. */
export function parseRunStartError(status: number, body: unknown): RunStartError {
  const outcome = classifyBilledResponse(status, body, 'Failed to start Market Pulse run');
  if (outcome.kind === 'credits') {
    // A human sentence arrives in `message` (older bodies) or `error` (final shape).
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const isSentence = (v: unknown) => typeof v === 'string' && v.trim() !== '' && !/^[A-Za-z0-9_]+$/.test(v.trim());
    const hasServerMessage = isSentence(b.message) || isSentence(b.error);
    return hasServerMessage ? outcome : { ...outcome, message: SCAN_CREDIT_FALLBACK[outcome.code] ?? outcome.message };
  }
  if (outcome.kind === 'error') return outcome;
  // A run start never answers 409 today; if it does, show its plain text rather than a code.
  return { kind: 'error', message: outcome.kind === 'ok' ? 'Failed to start Market Pulse run' : outcome.message };
}

function TopUpLink() {
  return (
    <Link href={TOP_UP_HREF} className="font-semibold text-indigo-700 underline">
      Top up credits
    </Link>
  );
}

export function MarketPulseCreditNotice({ notice }: { notice: CreditNotice | null }) {
  if (!notice) return null;
  const hasNumbers = typeof notice.required === 'number' || typeof notice.available === 'number';
  return (
    <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-medium">{notice.message}</p>
      {hasNumbers && (
        <p className="mt-1 text-amber-800">
          {typeof notice.required === 'number' ? `This scan needs ${notice.required} credits` : ''}
          {typeof notice.required === 'number' && typeof notice.available === 'number' ? '; ' : ''}
          {typeof notice.available === 'number' ? `you have ${notice.available}.` : '.'}
        </p>
      )}
      {notice.code !== 'pricing_unavailable' && (
        <p className="mt-2">
          <TopUpLink />
        </p>
      )}
    </div>
  );
}

/** Banner for a run that stopped part-way (status completed_with_warnings). */
export function MarketPulseRunWarnings({ status }: { status: string | null | undefined }) {
  if (String(status ?? '').toLowerCase() !== 'completed_with_warnings') return null;
  return (
    <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-medium">
        This scan finished with warnings: some regions didn’t complete. Results below cover the regions that did.
      </p>
    </div>
  );
}
