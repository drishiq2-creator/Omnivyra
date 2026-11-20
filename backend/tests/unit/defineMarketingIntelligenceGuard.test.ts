/**
 * 7c 2026-11-19: define-marketing-intelligence's guard trusted the CALLER's currentFields as "current".
 * A caller short a field (another client, a retry, a stale form) + an empty model value + no answer
 * returned '' for a field that has a stored value: the CI-391 loss in the sibling route, via the input.
 * Now "current" = the caller's value, else the STORED profile's; an all-empty field is omitted.
 */
import * as fs from 'fs';
import * as path from 'path';
import { finalizeConversationFields } from '../../services/companyProfile/aiProfileMerge';

const KEEP = /^(keep|same|fine|ok|okay|no ?change|leave it|leave as is|good|n\/?a|skip|-)\.?$/i;
const FIELDS = ['marketing_channels', 'content_strategy'] as const;
const run = (o: Partial<Parameters<typeof finalizeConversationFields>[0]>) =>
  finalizeConversationFields({ fields: FIELDS, userAnswers: [], modelFields: {}, callerCurrent: {}, stored: {}, keep: KEEP, ...o });

describe('finalizeConversationFields', () => {
  it('THE loss path: the caller omits a field, the model and the answer are empty -> the STORED value, not ""', () => {
    const out = run({ callerCurrent: { content_strategy: 'weekly blog' }, stored: { marketing_channels: 'LinkedIn', content_strategy: 'old' } });
    expect(out.marketing_channels).toBe('LinkedIn');
  });
  it('the caller’s value (may be an UNSAVED edit) wins over the stored one', () => {
    expect(run({ callerCurrent: { marketing_channels: 'Email (unsaved)' }, stored: { marketing_channels: 'LinkedIn' } }).marketing_channels).toBe('Email (unsaved)');
  });
  it('model non-empty wins; else the user’s answer; "keep" keeps current', () => {
    expect(run({ modelFields: { marketing_channels: 'SEO' }, stored: { marketing_channels: 'LinkedIn' } }).marketing_channels).toBe('SEO');
    expect(run({ userAnswers: ['Events'], stored: { marketing_channels: 'LinkedIn' } }).marketing_channels).toBe('Events');
    expect(run({ userAnswers: ['keep'], modelFields: { marketing_channels: 'SEO' }, stored: { marketing_channels: 'LinkedIn' } }).marketing_channels).toBe('LinkedIn');
  });
  it('a field with no value anywhere is OMITTED, never ""', () => {
    expect(run({})).toEqual({});
  });
  it('wiring: the route uses the shared guard with the STORED profile', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'pages/api/company-profile/define-marketing-intelligence.ts'), 'utf8');
    expect(src).toMatch(/finalizeConversationFields\(\{[\s\S]*?stored: profile as unknown as Record<string, unknown> \| null,[\s\S]*?\}\)/);
    expect(src).not.toMatch(/else finalFields\[field\] = cur;/);
  });
});
