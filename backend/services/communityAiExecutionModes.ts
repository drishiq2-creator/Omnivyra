/**
 * Community AI execution modes: the closed enum and the playbook permission
 * rule (Phase C). Pure and client-safe (no server imports): the playbook
 * validator, the executor and the execute route all read it from here.
 *
 *   manual  - human-driven, recorded as sent_unverified, no platform call;
 *   api     - platform connector with the org's token;
 *   rpa     - server-side Playwright, executed only on the browser worker;
 *   browser - command queued for the user's Omnivyra extension.
 *
 * Anything else is refused (execute route: 400; executor: fail closed).
 */
export const EXECUTION_MODES = ['manual', 'api', 'rpa', 'browser'] as const;
export type KnownExecutionMode = (typeof EXECUTION_MODES)[number];

/** '' / null / undefined -> null (not given); otherwise trimmed + lower-cased. */
export const normalizeExecutionModeInput = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().toLowerCase();
  return text.length === 0 ? null : text;
};

export const isKnownExecutionMode = (value: unknown): value is KnownExecutionMode =>
  typeof value === 'string' && (EXECUTION_MODES as readonly string[]).includes(value);

/** One decision for a requested mode: absent (use the default), a known mode, or invalid (refuse). */
export type ParsedExecutionMode =
  | { kind: 'absent' }
  | { kind: 'known'; mode: KnownExecutionMode }
  | { kind: 'invalid'; value: string };

export const parseExecutionMode = (value: unknown): ParsedExecutionMode => {
  const text = normalizeExecutionModeInput(value);
  if (text === null) return { kind: 'absent' };
  return isKnownExecutionMode(text) ? { kind: 'known', mode: text } : { kind: 'invalid', value: text };
};

/** Modes that drive a browser; each needs a playbook that explicitly permits it. */
export const PLAYBOOK_GATED_MODES: ReadonlySet<KnownExecutionMode> = new Set<KnownExecutionMode>(['rpa', 'browser']);

/**
 * A playbook's execution_modes block. playbookTypes has no browser flag: a
 * playbook opts in to browser execution with `browser_allowed === true`.
 */
export type ExecutionModesConfig = {
  api_allowed?: boolean | null;
  rpa_allowed?: boolean | null;
  browser_allowed?: boolean | null;
  manual_only?: boolean | null;
} | null | undefined;

/**
 * Does the playbook permit this mode? rpa and browser need their own flag set
 * to true (a missing execution_modes block permits neither). api keeps its
 * historical rule (refused only when a present block has api_allowed falsy).
 * manual is always permitted; manual_only refuses every other mode.
 */
export const playbookExecutionModeDecision = (
  executionModes: ExecutionModesConfig,
  mode: KnownExecutionMode,
): { allowed: true } | { allowed: false; reason: string } => {
  if (mode === 'manual') return { allowed: true };
  if (executionModes?.manual_only) {
    return { allowed: false, reason: 'Execution mode not permitted by playbook.' };
  }
  if (mode === 'api') {
    if (executionModes && !executionModes.api_allowed) {
      return { allowed: false, reason: 'API execution is not permitted by playbook.' };
    }
    return { allowed: true };
  }
  if (mode === 'rpa') {
    return executionModes?.rpa_allowed === true
      ? { allowed: true }
      : { allowed: false, reason: 'RPA execution is not permitted by playbook.' };
  }
  return executionModes?.browser_allowed === true
    ? { allowed: true }
    : { allowed: false, reason: 'Browser execution is not permitted by playbook.' };
};

/** An rpa run queued for the browser worker by a non-worker process (not attempted). */
export const RPA_QUEUED_FOR_WORKER = 'RPA_QUEUED_FOR_WORKER';
