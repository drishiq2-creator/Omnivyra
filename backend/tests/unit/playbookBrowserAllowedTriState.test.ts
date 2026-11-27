/**
 * Review SF-2 — the playbook editor's browser_allowed control shows the THIRD
 * state ("Not set" = absent: explicit browser refused, system fallback allowed)
 * and never converts it into true/false on save. The editor (PlaybookEditor.tsx)
 * binds its select to these helpers; jest here has no DOM harness for
 * components/, so the binding logic is tested directly and the editor source is
 * pinned to use it.
 */
import fs from 'fs';
import path from 'path';
import {
  BROWSER_ALLOWED_OPTIONS,
  applyBrowserAllowedChoice,
  browserAllowedToChoice,
} from '../../../components/community-ai/browserAllowedSetting';
import { playbookExecutionModeDecision } from '../../services/communityAiExecutionModes';

describe('SF-2: browser_allowed tri-state', () => {
  it('absent / null shows "Not set"; true / false show Allowed / Not allowed', () => {
    expect(browserAllowedToChoice(undefined)).toBe('unset');
    expect(browserAllowedToChoice(null)).toBe('unset');
    expect(browserAllowedToChoice(true)).toBe('allowed');
    expect(browserAllowedToChoice(false)).toBe('not_allowed');
    expect(BROWSER_ALLOWED_OPTIONS.map((o) => o.value)).toEqual(['unset', 'allowed', 'not_allowed']);
    expect(BROWSER_ALLOWED_OPTIONS[0].label).toMatch(/Not set.*fallback allowed/);
  });

  it('a legacy playbook (flag absent) round-trips with the key STILL ABSENT (never silently converted)', () => {
    const legacy = { api_allowed: true, rpa_allowed: false, manual_only: false };
    const saved = applyBrowserAllowedChoice(legacy, browserAllowedToChoice((legacy as any).browser_allowed));
    expect(saved).toEqual(legacy);
    expect(Object.prototype.hasOwnProperty.call(saved, 'browser_allowed')).toBe(false);
    // and the saved shape keeps the runtime meaning of "absent": fallback allowed, explicit refused
    expect(playbookExecutionModeDecision(saved, 'browser', 'system_fallback').allowed).toBe(true);
    expect(playbookExecutionModeDecision(saved, 'browser', 'requested').allowed).toBe(false);
  });

  it('choosing Allowed / Not allowed writes true / false; choosing Not set removes the key', () => {
    const base = { api_allowed: true, rpa_allowed: false, manual_only: false, browser_allowed: false };
    expect(applyBrowserAllowedChoice(base, 'allowed').browser_allowed).toBe(true);
    expect(applyBrowserAllowedChoice({ ...base, browser_allowed: true }, 'not_allowed').browser_allowed).toBe(false);
    const unset = applyBrowserAllowedChoice(base, 'unset');
    expect('browser_allowed' in unset).toBe(false);
    expect(unset).toEqual({ api_allowed: true, rpa_allowed: false, manual_only: false });
  });

  it('the editor binds its control to these helpers (no checkbox that cannot show "Not set")', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../components/community-ai/PlaybookEditor.tsx'), 'utf8');
    expect(src).toMatch(/value=\{browserAllowedToChoice\(draft\.execution_modes\.browser_allowed\)\}/);
    expect(src).toMatch(/applyBrowserAllowedChoice\(draft\.execution_modes, choice\)/);
    expect(src).not.toMatch(/checked=\{draft\.execution_modes\.browser_allowed/);
  });
});
