/**
 * Test helper: is `marker` CONTAINED in a region of `src` that renders only depending on
 * `gate`? Throws if the marker is missing, so a renamed control fails loudly instead of
 * passing vacuously.
 *
 * Containment, not proximity (7c review, 2026-11-18). Every conditional shape counts:
 *   gate && ( ... )        gate && <El ...>...</El>
 *   !gate && ( ... )       !gate && <El />
 *   gate ? ( A ) : ( B )   gate ? <A/> : <B/>   gate ? ( A ) : null
 * Both ternary branches are gated (each renders only for one value of `gate`).
 * The original helper only knew `gate && (`, so a fold rewritten as a ternary read as
 * "not gated" and a negative assertion ("this stays visible") passed while the field was
 * in fact folded.
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
  const re = new RegExp(`<${tag.replace(/\./g, '\\.')}(?=[\\s>/])|</${tag.replace(/\./g, '\\.')}>`, 'g');
  re.lastIndex = open;
  let depth = 0;
  for (let hit = re.exec(src); hit; hit = re.exec(src)) {
    if (hit[0].startsWith('</')) {
      depth--;
      if (depth === 0) return hit.index + hit[0].length;
      continue;
    }
    // end of this opening tag (skip over {...} expressions inside it)
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

/** The region of one conditional branch starting at or after `i` (skips whitespace). */
function branchAt(src: string, i: number): Range | null {
  let j = i;
  while (j < src.length && /\s/.test(src[j])) j++;
  if (src[j] === '(') return { start: j, end: parenEnd(src, j) };
  if (src[j] === '<') return { start: j, end: elementEnd(src, j) };
  return null; // e.g. `null`, a string, an identifier: nothing JSX-shaped to contain a marker
}

/** Every region whose rendering depends on `gate`. */
export function gatedRegions(src: string, gate: string): Range[] {
  const out: Range[] = [];
  const name = gate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\w.$])!?${name}(?![\\w$])\\s*(&&|\\?)`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const after = m.index + m[0].length;
    const first = branchAt(src, after);
    if (!first) continue;
    out.push(first);
    if (m[1] === '?') {
      let j = first.end;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === ':') {
        const second = branchAt(src, j + 1);
        if (second) out.push(second);
      }
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
