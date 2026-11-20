'use strict';
/**
 * STEP 3AH-118 (WS-F) — ordering POLICY for check-route-auth.js: which ordering
 * events are violations (R5-ORDER / R5-READ / R6-ORDER / R7-PRINCIPAL), and the
 * reviewed allowlist sections that narrow them. The analysis itself lives in
 * route-auth-ordering.js.
 *
 * Allowlist sections (scripts/route-auth-allowlist.json):
 *
 *   orderingVerifiers  { route: [{ verifier, reason }] }
 *       A non-primitive credential check (plugin token, integration secret)
 *       that authenticates a path before its side effects. Re-verified on
 *       every run: INVOKED in the served module and followed by a 401/403.
 *
 *   orderingPatterns   { route: [{ rule: 'R6-ORDER', pattern, reason, evidence, effects }] }
 *       A reviewed, named safe shape the flow analysis cannot prove. Narrow by
 *       construction: only R6-ORDER (never R5 — an unauthenticated side effect
 *       is never a pattern), only the listed `effects` (`kind detail file`
 *       signatures — a NEW effect still fails), and `evidence` must match the
 *       served module's executable code AND the pattern's required shape.
 *       Optional `effectsBeyondDepth: [{ effect, depth, reason }]` (b3 2026-11-20): an effect the route REALLY
 *       reaches, but past the summary depth cut (SUMMARY_DEPTH), so the normal run cannot observe it. Kept on the
 *       reviewed record instead of being deleted as "unused" (a deletion would record a false absence). Verified
 *       on every run by re-analysing the route at that depth: the effect must be covered at EXACTLY `depth` -
 *       not reached at `depth` = deleted from the code or depth UNDERSTATED; already reached at `depth - 1` =
 *       depth OVERSTATED (or, at SUMMARY_DEPTH, it belongs in `effects`).
 *
 *   authFirst          { route: { reason } }
 *       The route's contract requires authentication before ANY read (anti-
 *       enumeration). R5-READ applies to these routes and to identity-scoped
 *       entries; elsewhere a pre-authentication read is inventory, not failure
 *       (resolving a resource's tenant before authorizing it is the accepted
 *       tenant-resolution shape).
 */

const PROTECTED_EFFECTS = new Set(['db-write', 'db-rpc', 'storage', 'queue', 'outbound', 'external-call']);
// Contracts with no user authentication by design: ordering does not apply.
const ORDER_EXEMPT_KINDS = new Set(['public', 'health', 'auth-flow', 'oauth-start', 'oauth-callback', 'retired', 'redirect-shim']);

// Each pattern names the code shape its evidence must show (matched against the evidence's own match text).
const ORDERING_PATTERNS = {
  // The effect targets a resource owned by the AUTHENTICATED user (row filtered by / compared to the session user id).
  'identity-owned-resource': /\buser(?:\.id|\.userId|Id)\b|callerUserId/,
  // The tenant is derived from the authenticated caller's own membership, not from the request.
  'identity-derived-tenant': /user_company_roles|getUserCompanyRole|\buser\.id\b/,
  // An id that already exists is tenant-authorized first; only a new id is created (under the caller).
  'existence-conditioned-binding': /require\w*(?:Campaign|Company)\w*\(/,
};

const readSection = (fs, file, name, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))[name] || fallback;
  } catch {
    return fallback;
  }
};

function verifyOrderingVerifier(v, code, callRe) {
  const errs = [];
  if (!v || !/^[A-Za-z_$][\w$]*$/.test(String(v.verifier || ''))) return ['ordering verifier must name a function'];
  if (!v.reason || String(v.reason).trim().length < 20) errs.push(`ordering verifier ${v.verifier}: reason missing or too short`);
  const m = callRe(v.verifier).exec(code);
  if (!m) errs.push(`ordering verifier ${v.verifier} is not invoked`);
  else if (!/status\s*\(\s*40[13]\s*\)/.test(code.slice(m.index, m.index + 600))) errs.push(`ordering verifier ${v.verifier} is not followed by a 401/403 rejection`);
  return errs;
}

// The ordering analyzer's summary depth cut (route-auth-ordering.js imports it from here).
const SUMMARY_DEPTH = 3;
const BEYOND_DEPTH_MAX = 8;

function verifyBeyondDepth(p) {
  const errs = [];
  if (p.effectsBeyondDepth === undefined) return errs;
  if (!Array.isArray(p.effectsBeyondDepth) || p.effectsBeyondDepth.length === 0) return [`ordering pattern ${p.pattern}: effectsBeyondDepth must be a non-empty list when present`];
  for (const b of p.effectsBeyondDepth) {
    const label = `ordering pattern ${p.pattern}: effectsBeyondDepth ${b && b.effect}`;
    if (!b || typeof b.effect !== 'string' || !b.effect.trim()) { errs.push(`ordering pattern ${p.pattern}: effectsBeyondDepth entry must name an effect`); continue; }
    if (!Number.isInteger(b.depth) || b.depth <= SUMMARY_DEPTH || b.depth > BEYOND_DEPTH_MAX) errs.push(`${label}: depth must be an integer in ${SUMMARY_DEPTH + 1}..${BEYOND_DEPTH_MAX}`);
    if (!b.reason || String(b.reason).trim().length < 20) errs.push(`${label}: reason missing or too short`);
    if (Array.isArray(p.effects) && p.effects.includes(b.effect)) errs.push(`${label}: listed in effects too - an effect is either within the summary depth or beyond it`);
  }
  return errs;
}

function verifyOrderingPattern(p, code) {
  const errs = [];
  if (!p || p.rule !== 'R6-ORDER') return ['ordering pattern may only narrow R6-ORDER'];
  errs.push(...verifyBeyondDepth(p));
  if (!Object.prototype.hasOwnProperty.call(ORDERING_PATTERNS, p.pattern)) return [`unrecognised ordering pattern "${p.pattern}"`];
  if (!p.reason || String(p.reason).trim().length < 20) errs.push(`ordering pattern ${p.pattern}: reason missing or too short`);
  if (!Array.isArray(p.effects) || p.effects.length === 0) errs.push(`ordering pattern ${p.pattern}: must list the effects it covers`);
  let re;
  try { re = new RegExp(p.evidence); } catch { re = null; }
  if (!p.evidence || !re) return [...errs, `ordering pattern ${p.pattern}: "evidence" must be a valid regex`];
  const hit = re.exec(code);
  if (!hit) errs.push(`ordering pattern ${p.pattern}: evidence /${p.evidence}/ no longer matches the route`);
  else if (!ORDERING_PATTERNS[p.pattern].test(hit[0])) errs.push(`ordering pattern ${p.pattern}: evidence match "${hit[0].slice(0, 80)}" does not show the pattern's required shape`);
  return errs;
}

const signature = (e) => `${e.kind} ${e.detail} ${String(e.at).replace(/:\d+$/, '')}`;
const where = (e) => `${e.kind} ${e.detail} at ${e.at}${e.via.length ? ` (via ${e.via.join(' → ')})` : ''}`;

/**
 * Violations for one route. `patterns` are VERIFIED orderingPatterns entries;
 * `authFirst` is the route's authFirst entry (or null).
 * Returns { violations, preAuthReads, patterned } — patterned = signatures narrowed.
 */
function orderingViolations(order, { entry, level, ids, campaignKeyed, patterns = [], authFirst = null }) {
  const out = { violations: [], preAuthReads: 0, patterned: [], flagged: [] };
  if (order.shape !== 'resolved' || (entry && ORDER_EXEMPT_KINDS.has(entry.kind))) return out;
  const readContract = Boolean(authFirst) || Boolean(entry && entry.kind === 'identity-scoped');
  const tenantBound = !entry && (level === 'tenant' || level === 'platform') && (ids.length > 0 || campaignKeyed);
  const covered = new Set(patterns.flatMap((p) => p.effects));
  const buckets = { 'R5-ORDER': [], 'R5-READ': [], 'R6-ORDER': [] };
  for (const e of order.events) {
    if (!e.id && PROTECTED_EFFECTS.has(e.kind)) { buckets['R5-ORDER'].push(where(e)); out.flagged.push(`R5-ORDER ${signature(e)}`); }
    else if (!e.id && e.kind === 'db-read') {
      out.preAuthReads += 1;
      if (readContract) buckets['R5-READ'].push(where(e));
    } else if (e.id && !e.tenant && tenantBound && PROTECTED_EFFECTS.has(e.kind)) {
      if (covered.has(signature(e))) out.patterned.push(signature(e));
      else { buckets['R6-ORDER'].push(where(e)); out.flagged.push(`R6-ORDER ${signature(e)}`); }
    }
  }
  const text = {
    'R5-ORDER': 'runs before authentication on its path',
    'R5-READ': 'reads data before authentication, but the route contract requires authentication first',
    'R6-ORDER': 'runs after authentication but before tenant authorization',
  };
  for (const [rule, list] of Object.entries(buckets)) {
    const uniq = [...new Set(list)];
    if (uniq.length) out.violations.push({ rule, msg: `${text[rule]}: ${uniq.slice(0, 3).join('; ')}${uniq.length > 3 ? ` (+${uniq.length - 3} more)` : ''}` });
  }
  const principal = order.auth.filter((a) => a.callerPrincipal);
  if (principal.length) out.violations.push({ rule: 'R7-PRINCIPAL', msg: `authorization evaluated against a caller-controlled principal: ${principal.map((a) => `${a.name} at ${a.at}`).join('; ')}` });
  out.patterned = [...new Set(out.patterned)];
  out.flagged = [...new Set(out.flagged)];
  return out;
}

/**
 * Per-route glue: verify the route's ordering allowlist entries, run the
 * analysis, and return { order, verifierNames, violations, preAuthReads, patterned }.
 */
function applyOrdering({ rel, code, evidenceCode, entry, level, ids, campaignKeyed, sections, callRe, analyze }) {
  const violations = [];
  const verifierNames = entry && entry.verifier ? [entry.verifier] : [];
  for (const v of sections.orderingVerifiers[rel] || []) {
    const errs = verifyOrderingVerifier(v, code, callRe);
    for (const e of errs) violations.push({ rule: 'ALLOWLIST', msg: e });
    if (errs.length === 0) verifierNames.push(v.verifier);
  }
  const patterns = [];
  for (const p of sections.orderingPatterns[rel] || []) {
    const errs = verifyOrderingPattern(p, evidenceCode);
    for (const e of errs) violations.push({ rule: 'ALLOWLIST', msg: e });
    if (errs.length === 0) patterns.push(p);
  }
  const af = sections.authFirst[rel] || null;
  if (af && (!af.reason || String(af.reason).trim().length < 20)) violations.push({ rule: 'ALLOWLIST', msg: 'authFirst reason missing or too short' });
  const order = analyze(verifierNames);
  const r = orderingViolations(order, { entry, level, ids, campaignKeyed, patterns, authFirst: af });
  violations.push(...r.violations);
  const unused = patterns.flatMap((p) => p.effects).filter((s) => !r.patterned.includes(s));
  // effectsBeyondDepth: re-analyse at the stated depth (and one less) and require EXACT reach.
  const beyond = patterns.flatMap((p) => p.effectsBeyondDepth || []);
  if (beyond.length) {
    const byDepth = new Map();
    const coveredAt = (depth) => {
      if (!byDepth.has(depth)) {
        const o = depth === SUMMARY_DEPTH ? order : analyze(verifierNames, { summaryDepth: depth });
        const rr = orderingViolations(o, { entry, level, ids, campaignKeyed, patterns: [{ effects: beyond.map((b) => b.effect) }], authFirst: af });
        byDepth.set(depth, new Set(rr.patterned));
      }
      return byDepth.get(depth);
    };
    for (const b of beyond) {
      if (!coveredAt(b.depth).has(b.effect)) {
        violations.push({ rule: 'ALLOWLIST', msg: `effectsBeyondDepth ${b.effect}: not reached at the stated depth ${b.depth} (removed from the code, or the depth is understated)` });
      } else if (coveredAt(b.depth - 1).has(b.effect)) {
        violations.push({ rule: 'ALLOWLIST', msg: b.depth - 1 === SUMMARY_DEPTH
          ? `effectsBeyondDepth ${b.effect}: reached within SUMMARY_DEPTH (${SUMMARY_DEPTH}) - list it under effects`
          : `effectsBeyondDepth ${b.effect}: already reached at depth ${b.depth - 1} (the stated depth ${b.depth} is overstated)` });
      }
    }
  }
  return { order, violations, preAuthReads: r.preAuthReads, patterned: r.patterned, flagged: r.flagged, unusedPatternEffects: unused };
}

function loadOrderingSections(fs, file) {
  return {
    orderingVerifiers: readSection(fs, file, 'orderingVerifiers', {}),
    orderingPatterns: readSection(fs, file, 'orderingPatterns', {}),
    authFirst: readSection(fs, file, 'authFirst', {}),
  };
}

module.exports = {
  PROTECTED_EFFECTS,
  ORDER_EXEMPT_KINDS,
  ORDERING_PATTERNS,
  verifyOrderingVerifier,
  verifyOrderingPattern,
  orderingViolations,
  applyOrdering,
  loadOrderingSections,
  signature,
  SUMMARY_DEPTH,
  BEYOND_DEPTH_MAX,
};
