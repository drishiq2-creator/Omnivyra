/**
 * The gate scan used by the "is this field folded / gated?" tests (7c review 2026-11-18):
 * containment for every conditional shape, so a NEGATIVE assertion ("stays visible") can't
 * pass while the marker is in fact behind a ternary or paren-less gate.
 */
import { insideWriteGate, gatedRegions } from '../helpers/writeGateScan';

const M = 'MARKER_TOPIC';

describe('insideWriteGate: containment for every conditional shape', () => {
  it.each([
    ['gate && ( ... )', `<div>{showMore && (<p>${M}</p>)}</div>`],
    ['gate && <El>…</El> (no parens)', `<div>{showMore && <p>${M}</p>}</div>`],
    ['!gate && ( ... )', `<div>{!showMore && (<p>${M}</p>)}</div>`],
    ['gate ? ( A ) : null  (marker in A)', `<div>{showMore ? (<p>${M}</p>) : null}</div>`],
    ['gate ? ( A ) : ( B )  (marker in B)', `<div>{showMore ? (<p>x</p>) : (<p>${M}</p>)}</div>`],
    ['gate ? <A/> : <B>…</B>  (marker in B, no parens)', `<div>{showMore ? <hr /> : <p>${M}</p>}</div>`],
    ['nested elements of the same tag', `{showMore && <div><div>a</div><div>${M}</div></div>}`],
    ['an expression attribute containing >', `{showMore && <p title={a > b ? 'x' : 'y'}>${M}</p>}`],
    // 7c, re-review of b88577ea8: these FAILED there (first branch not JSX -> B-branch lost)
    ['gate ? null : ( B )', `<div>{showMore ? null : (<p>${M}</p>)}</div>`],
    ["gate ? '' : <B/>", `<div>{showMore ? '' : <p>${M}</p>}</div>`],
    ['gate ? undefined : <B/>', `<div>{showMore ? undefined : <p>${M}</p>}</div>`],
    ['gate ? <></> : ( B )', `<div>{showMore ? <></> : (<p>${M}</p>)}</div>`],
    ['nested ternary in A, marker in B', `{showMore ? (flag ? <i>a</i> : null) : (<p>${M}</p>)}`],
    // member-expression gates (7c): invisible to b88577ea8's lookbehind
    ['d.gate && ( ... )', `<div>{d.showMore && (<p>${M}</p>)}</div>`],
    ['props.gate ? null : ( B )', `<div>{props.showMore ? null : (<p>${M}</p>)}</div>`],
  ])('%s -> gated', (_shape, src) => {
    expect(insideWriteGate(src, M, 'showMore')).toBe(true);
  });

  it.each([
    ['outside, after the gated region', `<div>{showMore && (<p>a</p>)}<p>${M}</p></div>`],
    ['a different gate', `<div>{otherFlag && (<p>${M}</p>)}</div>`],
    ['a longer identifier that merely starts with the gate', `<div>{showMoreDetails && (<p>${M}</p>)}</div>`],
    ['a gate mentioned only in a comment far away', `{/* showMore toggles extras */}\n<p>${M}</p>`],
  ])('%s -> not gated', (_shape, src) => {
    expect(insideWriteGate(src, M, 'showMore')).toBe(false);
  });

  it.each([
    ['plain boolean logic', `const ok = showMore && other;\n<p>${M}</p>`],
    ['optional chaining is not a ternary', `const v = showMore?.x;\n<p>${M}</p>`],
    ['nullish coalescing is not a ternary', `const v = showMore ?? false;\n<p>${M}</p>`],
  ])('%s -> not gated, and no throw', (_shape, src) => {
    expect(insideWriteGate(src, M, 'showMore')).toBe(false);
  });

  it('an unparseable ternary on the gate throws (never guesses "not gated")', () => {
    expect(() => insideWriteGate(`{showMore ? (<p>a</p>)}\n<p>${M}</p>`, M, 'showMore')).toThrow(/can't find the ':'/);
  });

  it('throws when the marker is missing (never passes vacuously)', () => {
    expect(() => insideWriteGate('<p>x</p>', M, 'showMore')).toThrow(/marker not found/);
  });

  it('both ternary branches are reported as gated regions', () => {
    const src = `{showMore ? (<p>a</p>) : (<p>b</p>)}`;
    expect(gatedRegions(src, 'showMore')).toHaveLength(2);
  });
});
