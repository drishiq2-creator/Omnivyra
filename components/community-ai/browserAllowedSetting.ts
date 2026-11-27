/**
 * Playbook `execution_modes.browser_allowed` as the editor shows it (review SF-2).
 *
 * The flag has THREE states and the absent one has its own meaning
 * (backend/services/communityAiExecutionModes.ts playbookExecutionModeDecision):
 *   absent / null -> "Not set": an explicitly requested browser mode is refused,
 *                    the executor's own API -> browser fallback is allowed
 *                    (every playbook saved before the flag existed);
 *   true          -> "Allowed": explicit browser requests and the fallback;
 *   false         -> "Not allowed": neither.
 * A checkbox cannot show "Not set", so the editor uses a select bound to these
 * helpers. Saving never converts "Not set" into true/false: the key stays absent.
 */
export type BrowserAllowedChoice = 'unset' | 'allowed' | 'not_allowed';

export const BROWSER_ALLOWED_OPTIONS: ReadonlyArray<{ value: BrowserAllowedChoice; label: string }> = [
  { value: 'unset', label: 'Not set (explicit browser refused; system fallback allowed)' },
  { value: 'allowed', label: 'Allowed (explicit browser and fallback)' },
  { value: 'not_allowed', label: 'Not allowed (no browser, no fallback)' },
];

export const browserAllowedToChoice = (value: boolean | null | undefined): BrowserAllowedChoice =>
  value === true ? 'allowed' : value === false ? 'not_allowed' : 'unset';

/** Apply a choice to an execution_modes object; 'unset' REMOVES the key (never writes true/false). */
export function applyBrowserAllowedChoice<T extends { browser_allowed?: boolean | null }>(
  modes: T,
  choice: BrowserAllowedChoice,
): T {
  const { browser_allowed: _drop, ...rest } = modes;
  if (choice === 'unset') return rest as T;
  return { ...(rest as T), browser_allowed: choice === 'allowed' };
}

export const isBrowserAllowedChoice = (v: unknown): v is BrowserAllowedChoice =>
  v === 'unset' || v === 'allowed' || v === 'not_allowed';
