/**
 * 'blocked' (owner decision 2026-11-22): a business-rule restriction - today the plan's usage limit refusing an
 * execution (PLAN_LIMIT_EXCEEDED) - is its own action status, never an execution failure. This turns the stored
 * execution_result of a blocked action into the reason shown to people.
 */
export const BLOCKED_STATUS = 'blocked';

const REASONS: Record<string, string> = {
  PLAN_LIMIT_EXCEEDED: 'Plan limit reached - this action was not executed.',
};

export function blockedReasonCode(executionResult: unknown): string | null {
  if (!executionResult || typeof executionResult !== 'object') return null;
  const r = executionResult as { error?: unknown; reason?: unknown };
  const err = r.error;
  if (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string') return (err as { code: string }).code;
  if (typeof err === 'string' && err) return err;
  if (typeof r.reason === 'string' && r.reason) return r.reason;
  return null;
}

export function blockedReasonText(executionResult: unknown): string {
  const code = blockedReasonCode(executionResult);
  if (code && REASONS[code]) return REASONS[code];
  return code ? `Blocked (${code}) - this action was not executed.` : 'Blocked - this action was not executed.';
}
