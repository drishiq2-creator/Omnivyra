/**
 * SOURCE PIN for the billed-AI TIME AXIS (7c, 2026-11-21, on the wizard rebase a50abde87).
 *
 * runBilledAiCompletion answers a price-resolution failure by WHEN it happened:
 *   - before the provider call -> PRICING_UNAVAILABLE (503 + Retry-After): nothing ran, a retry is right;
 *   - after it                 -> deliver the produced text, flagged settlementUnpriced; NEVER invite a retry
 *                                 (a retry would pay the provider twice).
 * "When" is the `providerCallStarted` flag, set inside the shared `callAi`.
 *
 * WHY A SOURCE PIN AND NOT A BEHAVIOURAL TEST: moving `providerCallStarted = true` to AFTER the gateway call is an
 * EQUIVALENT MUTANT today - no price error originates DURING the provider call (they arise at hold time, before
 * callAi, or at settlement, after it returns), so both positions answer identically and no behavioural test can
 * kill it. The equivalence is a property of today's call graph, not of the design: the day anything inside
 * runWithCreditHandle / runCompletionWithOperation resolves a price, the positions diverge and the late flag turns a
 * completed, paid-for call into a 503 that invites a retry (the BLOCKING defect 7c raised on 8ff86fd72).
 * So the placement is pinned here, by reading the file. The checker is a pure function with failing controls below.
 *
 * IF THIS GOES RED AFTER A REFORMAT: that is a prompt, not a bug. The pin matches the flag line and the gateway line
 * exactly (after trimming), so a reformat fails it on purpose rather than passing silently. Re-check the placement
 * by hand (flag immediately before the provider call, produced text immediately after), then update the patterns.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const FILE = 'backend/services/billing/runBilledAiCompletion.ts';

/** Code lines only: comments and blank lines removed, trimmed. */
function codeLines(src: string): string[] {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter((l) => l.length > 0);
}

/** The body of `const callAi = async () => { ... };`, as code lines (brace-matched). */
function callAiBody(src: string): string[] | null {
  const lines = codeLines(src);
  const start = lines.findIndex((l) => /^const callAi = async \(\) => \{$/.test(l));
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
    }
    if (depth === 0) return lines.slice(start + 1, i);
  }
  return null;
}

export function timeAxisViolations(src: string): string[] {
  const v: string[] = [];
  const body = callAiBody(src);
  if (!body) return ['callAi not found'];

  const gw = body.findIndex((l) => /^const gatewayResp = await runWithCreditHandle\(/.test(l));
  if (gw < 0) v.push('the gateway call is not inside callAi');
  else {
    // 1. The flag is the statement IMMEDIATELY before the gateway call (nothing that can throw in between).
    if (gw === 0 || body[gw - 1] !== 'providerCallStarted = true;') {
      v.push('providerCallStarted = true is not the statement immediately before the gateway call');
    }
    // 2. The flag is set exactly once, and only there.
    if (body.filter((l) => l === 'providerCallStarted = true;').length !== 1) v.push('flag set more than once in callAi');
    // 3. producedText is recorded AFTER the gateway call, with no await between them.
    const pt = body.findIndex((l) => /^producedText = text;$/.test(l));
    if (pt < 0 || pt < gw) v.push('producedText = text is not after the gateway call');
    else if (body.slice(gw + 1, pt).some((l) => /\bawait\b/.test(l))) v.push('an await sits between the gateway call and producedText');
  }

  const all = codeLines(src);
  // 4. callAi is the ONLY provider path: one gateway call in the file, and both pricing modes go through callAi.
  if (all.filter((l) => /runCompletionWithOperation\(/.test(l)).length !== 1) v.push('runCompletionWithOperation is called outside callAi');
  if (all.filter((l) => /await callAi\(\)/.test(l)).length !== 2) v.push('not exactly two callAi() call sites (fixed + token)');
  // 5. Nothing else ever sets the flag to true.
  if (all.filter((l) => /providerCallStarted = true/.test(l)).length !== 1) v.push('providerCallStarted set to true outside callAi');
  return v;
}

const source = readFileSync(join(process.cwd(), FILE), 'utf8');

describe('billed-AI time axis: the flag and the produced text are pinned to the provider call', () => {
  it('the real runBilledAiCompletion.ts has no violations', () => {
    expect(timeAxisViolations(source)).toEqual([]);
  });

  // Failing controls: each mutation of the REAL source must be caught (proves the checker is not vacuous).
  const mutate = (from: string, to: string): string => {
    expect(source.includes(from)).toBe(true); // the control is about the real file, not a stand-in
    return source.replace(from, to);
  };

  it('CONTROL: the equivalent mutant - flag moved AFTER the gateway call - is caught', () => {
    const m = mutate('    providerCallStarted = true;\n', '').replace(
      '    producedText = text;\n', '    providerCallStarted = true;\n    producedText = text;\n');
    expect(timeAxisViolations(m)).toContain('providerCallStarted = true is not the statement immediately before the gateway call');
  });

  it('CONTROL: an await inserted between the flag and the gateway call is caught', () => {
    const m = mutate('    providerCallStarted = true;\n', '    providerCallStarted = true;\n    await Promise.resolve();\n');
    expect(timeAxisViolations(m)).toContain('providerCallStarted = true is not the statement immediately before the gateway call');
  });

  it('CONTROL: producedText never recorded is caught', () => {
    const m = mutate('    producedText = text;\n', '');
    expect(timeAxisViolations(m)).toContain('producedText = text is not after the gateway call');
  });

  it('CONTROL: a second provider path outside callAi is caught', () => {
    const m = mutate('  const providerOf = ', '  const bypass = () => runCompletionWithOperation({ ...args.completion });\n  const providerOf = ');
    expect(timeAxisViolations(m)).toContain('runCompletionWithOperation is called outside callAi');
  });

  it('CONTROL: a comment mentioning the flag does not satisfy the pin', () => {
    const m = mutate('    providerCallStarted = true;\n', '    // providerCallStarted = true;\n');
    expect(timeAxisViolations(m).length).toBeGreaterThan(0);
  });
});
