/**
 * Test helper: is `marker` CONTAINED in a region of `src` that renders only depending on
 * `gate`? Throws if the marker is missing, so a renamed control fails loudly instead of
 * passing vacuously.
 *
 * Containment, not proximity (7c review, 2026-11-18). Every conditional shape counts:
 *   gate && ( ... )        gate && <El ...>...</El>
 *   !gate && ( ... )       !gate && <El />
 *   gate ? ( A ) : ( B )   gate ? <A/> : <B/>   gate ? ( A ) : null   gate ? null : ( B )
 * Both ternary branches are gated (each renders only for one value of `gate`), including
 * when the OTHER branch is not JSX (null, '', undefined, a call).
 * Member-expression gates (`d.showMore`, `props.mayRecord`) are recognised too.
 *
 * Fails LOUD rather than guessing: a ternary on the gate whose ':' or second branch it can't
 * parse throws. A non-JSX `&&` operand (plain boolean logic such as `const ok = gate && x;`)
 * renders nothing that could contain a JSX marker, so it is not a region.
 *
 * Known limit: the opening tag's end is found at the first '>' outside `{...}`, so a '>' inside
 * a QUOTED attribute (`<El title="a > b">`) would end it early. Not used that way in this repo.
 */

type Range = { start: number; end: number };

/** Index just past the `)` matching the `(` at `open`. */
function parenEnd(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error('writeGateScan: unbalanced parentheses');
}

/** Index just past the JSX element starting at `open` ('<'): handles nesting and self-closing. */
function elementEnd(src: string, open: number): number {
  const m = /^<([A-Za-z][\w.]*)/.exec(src.slice(open));
  if (!m) throw new Error('writeGateScan: expected a JSX element');
  const tag = m[1];
  const t = tag.replace(/\./g, '\\.');
  const re = new RegExp(`<${t}(?=[\\s>/])|</${t}>`, 'g');
  re.lastIndex = open;
  let depth = 0;
  for (let hit = re.exec(src); hit; hit = re.exec(src)) {
    if (hit[0].startsWith('</')) {
      depth--;
      if (depth === 0) return hit.index + hit[0].length;
      continue;
    }
    let k = hit.index + hit[0].length;
    let braces = 0;
    for (; k < src.length; k++) {
      const c = src[k];
      if (c === '{') braces++;
      else if (c === '}') braces--;
      else if (c === '>' && braces === 0) break;
    }
    if (src[k - 1] === '/') {
      if (depth === 0) return k + 1;
    } else depth++;
    re.lastIndex = k + 1;
  }
  throw new Error(`writeGateScan: unbalanced <${tag}>`);
}

const skipWs = (src: string, i: number) => {
  let j = i;
  while (j < src.length && /\s/.test(src[j])) j++;
  return j;
};

/** A JSX-shaped branch (paren group or element) starting at or after `i`; null otherwise. */
function jsxBranchAt(src: string, i: number): Range | null {
  const j = skipWs(src, i);
  if (src[j] === '(') return { start: j, end: parenEnd(src, j) };
  if (src[j] === '<' && /[A-Za-z]/.test(src[j + 1] ?? '')) return { start: j, end: elementEnd(src, j) };
  return null;
}

/** Index of the ':' that closes the ternary whose '?' is just before `i` (depth- and nesting-aware). */
function ternaryColon(src: string, i: number): number {
  let depth = 0;
  let pendingQ = 0;
  let quote: string | null = null;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (quote) {
      if (c === '\\') k++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break; // left the enclosing expression without finding ':'
      depth--;
    } else if (depth === 0 && c === '?' && src[k + 1] !== '.' && src[k + 1] !== '?') pendingQ++;
    else if (depth === 0 && c === ':') {
      if (pendingQ === 0) return k;
      pendingQ--;
    }
  }
  return -1;
}

/** Every region whose rendering depends on `gate`. */
export function gatedRegions(src: string, gate: string): Range[] {
  const out: Range[] = [];
  const name = gate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // optional `!`, optional member prefix (`d.`, `props.`), the gate, then `&&` or `?` (not `?.` / `??`)
  const re = new RegExp(`(?<![\\w$.])!?(?:[\\w$]+\\.)*${name}(?![\\w$])\\s*(&&|\\?(?![.?]))`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const after = m.index + m[0].length;
    if (m[1] === '&&') {
      const body = jsxBranchAt(src, after);
      if (body) out.push(body); // a non-JSX operand is boolean logic, not a render region
      continue;
    }
    // ternary: BOTH branches are gated, whatever shape the other one has
    const first = jsxBranchAt(src, after);
    if (first) out.push(first);
    const colon = ternaryColon(src, first ? first.end : after);
    if (colon < 0) throw new Error(`writeGateScan: can't find the ':' of a ternary on ${gate}`);
    const second = jsxBranchAt(src, colon + 1);
    if (second) out.push(second);
    if (!first && !second) {
      // neither branch is JSX (e.g. `gate ? 'a' : 'b'`): nothing to contain a JSX marker
      continue;
    }
  }
  return out;
}

/** Is `marker` inside any region gated on `gate` (any of the shapes above)? */
export function insideWriteGate(src: string, marker: string, gate = 'canWriteThisCampaign'): boolean {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  return gatedRegions(src, gate).some((r) => at > r.start && at < r.end);
}
