/**
 * Client side of the double-charge contract (b3 2026-11-18): for every route in the SERVER registry
 * (backend/services/billing/keyRequiredRoutes, c6), every client call that hits a key-requiring value
 * must send the Idempotency-Key.
 *
 * Both sides are derived (7c): the route list and the per-request rule come from the registry; the call
 * sites are found by scanning the client tree for the route PATH (a literal, or an identifier whose
 * initialiser contains it), so a caller that never imports our helpers is still seen.
 *
 * Per call: if the call text carries `<field>: '<value>'` with a NOT-required value (e.g. mode 'angles',
 * action 'improve_variant') it is exempt; a required value, a non-literal value, or no value at all is
 * treated as REQUIRED (conservative), and the call must carry a key header (`Idempotency-Key` or a
 * spread/property `.headers` from a key operation).
 */
export interface RegistryEntry {
  route: string;
  field: 'action' | 'mode';
  values: readonly string[] | { except: readonly string[] };
}

export interface CallSite {
  file: string;
  route: string;
  callText: string;
  value: string | null; // the literal field value found in the call, if any
  required: boolean;
  keyed: boolean;
}

const CALLERS = /\b(fetch|apiFetch|fetchWithAuth)\s*\(/g;
const KEY_TOKEN = /Idempotency-Key|\.headers\b/;

function balancedFrom(src: string, openParen: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openParen; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth === 0) return src.slice(openParen, i + 1); }
  }
  return src.slice(openParen);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Identifiers whose initialiser mentions the route literal (e.g. `const CONTENT_API = '/api/...'`). */
function aliasesFor(src: string, route: string): string[] {
  const out: string[] = [];
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[2].includes(`'${route}'`) || m[2].includes(`"${route}"`) || m[2].includes(`\`${route}\``)) out.push(m[1]);
  }
  return out;
}

export function isRequired(entry: RegistryEntry, value: string | null): boolean {
  if (value === null) return true; // no literal value: conservative
  if (Array.isArray(entry.values)) return (entry.values as readonly string[]).includes(value);
  return !(entry.values as { except: readonly string[] }).except.includes(value);
}

export function scanSource(file: string, src: string, entries: readonly RegistryEntry[]): CallSite[] {
  const sites: CallSite[] = [];
  for (const entry of entries) {
    const literal = [`'${entry.route}'`, `"${entry.route}"`, `\`${entry.route}\``];
    const aliases = aliasesFor(src, entry.route);
    if (!literal.some((l) => src.includes(l)) && aliases.length === 0) continue;
    CALLERS.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALLERS.exec(src))) {
      const open = m.index + m[0].length - 1;
      const callText = balancedFrom(src, open);
      const firstArg = callText.slice(1).trimStart();
      const hits = literal.some((l) => firstArg.startsWith(l)) || aliases.some((a) => new RegExp(`^${escapeRe(a)}\\b`).test(firstArg));
      if (!hits) continue;
      const vm = new RegExp(`\\b${entry.field}\\s*:\\s*(['"\`])([^'"\`]+)\\1`).exec(callText);
      const value = vm ? vm[2] : null;
      const required = isRequired(entry, value);
      sites.push({ file, route: entry.route, callText, value, required, keyed: KEY_TOKEN.test(callText) });
    }
  }
  return sites;
}
