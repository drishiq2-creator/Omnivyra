/**
 * "What this run costs", shown BEFORE the user starts it (owner rule: cost before consent).
 *
 * Price comes from the pricing catalog (useActivityCostRanges), never a client literal. This is a
 * PRICE line, not an affordability check (7c, 2026-11-18): whether the run may start is decided
 * only by the server's admission (a 402 renders `required` / `available` verbatim via the billed
 * helper), so this line never compares against a balance.
 *
 * - not priced yet (the action is in `unknown`) or the catalog can't be read -> "price unavailable"
 *   (c6: never guess);
 * - `free` (e.g. an API-only Market Pulse source, c6: costs 0) -> says no credits are used;
 * - fixed price per unit -> "N credits (P per <unit> × Q <units>)";
 * - a token-priced band -> "about MIN–MAX credits" (the final charge settles to actual usage).
 */
import React from 'react';
import { useActivityCostRanges } from '../../hooks/useActivityCostRanges';

export function runCostText(args: {
  range: { minCredits: number; maxCredits: number; tokenPriced: boolean } | null;
  quantity: number;
  unit: string;
  unitPlural: string;
  /** What is being paid for, e.g. 'run' (default) or 'blog'. */
  noun?: string;
}): string {
  const { range, unit, unitPlural } = args;
  const noun = args.noun ?? 'run';
  const q = Math.max(1, Math.floor(args.quantity));
  if (!range) return 'Price unavailable right now.';
  const fixed = !range.tokenPriced || range.maxCredits <= range.minCredits;
  if (fixed) {
    const total = range.minCredits * q;
    const per = q > 1 ? ` (${range.minCredits} per ${unit} × ${q} ${unitPlural})` : '';
    return `This ${noun} uses ${total} credit${total === 1 ? '' : 's'}${per}.`;
  }
  return `This ${noun} uses about ${range.minCredits * q}–${range.maxCredits * q} credits; the final charge is what it actually uses.`;
}

export default function RunCostLine({
  companyId,
  actionKey,
  quantity,
  unit,
  unitPlural,
  free = false,
  freeText = 'This run doesn’t use credits.',
  className = '',
  noun,
}: {
  companyId: string;
  actionKey: string;
  quantity: number;
  unit: string;
  unitPlural: string;
  free?: boolean;
  freeText?: string;
  className?: string;
  noun?: string;
}) {
  const { ranges, unknown, loading, error } = useActivityCostRanges(free ? '' : companyId, actionKey);
  let text: string;
  if (free) text = freeText;
  else if (loading && ranges.length === 0) text = 'Checking the price…';
  else if (error || unknown.includes(actionKey)) text = 'Price unavailable right now.';
  else text = runCostText({ range: ranges.find((r) => r.actionKey === actionKey) ?? null, quantity, unit, unitPlural, noun });
  return (
    <p className={`text-xs text-gray-600 ${className}`} data-testid={`run-cost-${actionKey}`}>
      {text}
    </p>
  );
}
