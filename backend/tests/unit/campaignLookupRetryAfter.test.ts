/**
 * Structural pin (05 review, 2026-11-14): every retryable "campaign ownership lookup unavailable" answer - a 503 with
 * code CAMPAIGN_LOOKUP_ERROR - carries `Retry-After: SEAM_RETRY_AFTER_SECONDS` (backend/db/seamDenial.ts), the same
 * contract seamDenial gives a retryable TenantSeamError. Before this pin only four routes sent the header.
 *
 * How it decides, per non-test source file that mentions CAMPAIGN_LOOKUP_ERROR:
 *  - a SITE is a `.status(503)` whose `.json(...)` body names CAMPAIGN_LOOKUP_ERROR, names a const whose initializer
 *    does, or is one of the reviewed INDIRECT sites below (the code travels through a result object);
 *  - each site must call `res.setHeader('Retry-After', String(SEAM_RETRY_AFTER_SECONDS))` in ITS OWN block, before the
 *    503 (a header set in a sibling/nested block, or a ternary `cond ? res.status(503)... : ...`, does not count);
 *  - every occurrence of the token must be explained by a site, a const a site sends, or a reviewed INDIRECT producer,
 *    so a new emitter in another shape (res.statusCode = 503, sendStatus, a helper) fails here instead of slipping by;
 *  - the file imports SEAM_RETRY_AFTER_SECONDS from seamDenial (no hard-coded 5).
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const ROOT = path.resolve(__dirname, '../../..');
const TOKEN = 'CAMPAIGN_LOOKUP_ERROR';
const HEADER_RE = /\bres\.setHeader\(\s*'Retry-After'\s*,\s*String\(\s*SEAM_RETRY_AFTER_SECONDS\s*\)\s*\)/;

/**
 * Reviewed indirect emitters: the token is produced in a result object and mapped to the HTTP 503 elsewhere in the
 * same file. `site` marks the 503 statement; `producers` mark the token occurrences that feed it.
 */
const INDIRECT: Record<string, { site: string; producers: string[] }> = {
  'pages/api/engagement/reply.ts': {
    site: 'code: resolved.code, retryable: true',
    producers: [
      "return { ok: false, code: 'CAMPAIGN_LOOKUP_ERROR', message:",
      "const retryable = resolved.code === 'CAMPAIGN_LOOKUP_ERROR'",
    ],
  },
};

/** Expected sites per file, by NAME. A new emitter or a removed one must update this list on purpose. */
const EXPECTED: Record<string, number> = {
  'backend/security/TenantGuard.ts': 1,
  'backend/services/activityWorkspace/contentRouteHandler.ts': 2,
  'backend/services/userContextService.ts': 1,
  'pages/api/campaigns/approve-preemption.ts': 1,
  'pages/api/campaigns/execute-preemption.ts': 1,
  'pages/api/campaigns/index.ts': 2,
  'pages/api/campaigns/[id].ts': 1,
  'pages/api/campaigns/[id]/approve-frequency-rebalance.ts': 1,
  'pages/api/campaigns/[id]/approve-strategy.ts': 1,
  'pages/api/campaigns/[id]/continuity.ts': 1,
  'pages/api/campaigns/[id]/engagement-health.ts': 1,
  'pages/api/campaigns/[id]/health.ts': 1,
  'pages/api/campaigns/[id]/propose-frequency-rebalance.ts': 1,
  'pages/api/campaigns/[id]/reject-frequency-rebalance.ts': 1,
  'pages/api/campaigns/[id]/revise-strategy.ts': 1,
  'pages/api/campaigns/[id]/strategic-insights.ts': 1,
  'pages/api/content/regenerate.ts': 1,
  'pages/api/engagement/crm-export.ts': 1,
  'pages/api/engagement/reply.ts': 1,
  'pages/api/engagement/signal/status.ts': 1,
  'pages/api/schedule/reschedule.ts': 1,
};
/** Sites that gained the header in this change (the four [id] routes of 3543b2558 already had it). */
const CONVERTED_IN_THIS_CHANGE = 20;

type Site = { line: number; hasHeader: boolean };
type Scan = { sites: Site[]; unexplained: number[]; importsConstant: boolean; hardCoded: boolean };

const lineOf = (src: string, idx: number) => src.slice(0, idx).split('\n').length;

/** End index (exclusive) of the parenthesised group that opens at `open` (src[open] === '('). */
function closeParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return i + 1;
  }
  return src.length;
}

/** The text of the enclosing block before `pos`, at that block's own depth only (nested blocks dropped). */
function ownBlockPrefix(src: string, pos: number): string {
  let depth = 0;
  const out: string[] = [];
  for (let i = pos - 1; i >= 0; i--) {
    const c = src[i];
    if (c === '}') { depth++; continue; }
    if (c === '{') { if (depth === 0) break; depth--; continue; }
    if (depth === 0) out.push(c);
  }
  return out.reverse().join('');
}

/** Pure scanner (fixtures feed it in the positive controls). */
export function scanCampaignLookup503(rel: string, src: string): Scan {
  const constRanges: Array<{ name: string; start: number; end: number }> = [];
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*(?:Object\.freeze\()?\{[^{}]*\}/g)) {
    if (m[0].includes(TOKEN)) constRanges.push({ name: m[1], start: m.index!, end: m.index! + m[0].length });
  }
  const indirect = INDIRECT[rel];
  const explained: Array<[number, number]> = [];
  const sites: Site[] = [];
  for (const m of src.matchAll(/\.status\(\s*503\s*\)/g)) {
    const start = m.index!;
    const jsonAt = src.indexOf('.json(', start);
    if (jsonAt < 0) continue;
    const end = closeParen(src, jsonAt + '.json'.length);
    const stmt = src.slice(start, end);
    const viaConst = constRanges.filter((c) => new RegExp(`\\b${c.name}\\b`).test(stmt));
    const isSite = stmt.includes(TOKEN) || viaConst.length > 0 || (!!indirect && stmt.includes(indirect.site));
    if (!isSite) continue;
    explained.push([start, end]);
    viaConst.forEach((c) => explained.push([c.start, c.end]));
    sites.push({ line: lineOf(src, start), hasHeader: HEADER_RE.test(ownBlockPrefix(src, start)) });
  }
  if (indirect && sites.length > 0) {
    for (const p of indirect.producers) {
      const at = src.indexOf(p);
      if (at >= 0) explained.push([at, at + p.length]);
    }
  }
  const unexplained: number[] = [];
  for (let at = src.indexOf(TOKEN); at >= 0; at = src.indexOf(TOKEN, at + 1)) {
    if (!explained.some(([s, e]) => at >= s && at < e)) unexplained.push(lineOf(src, at));
  }
  return {
    sites,
    unexplained,
    importsConstant: /import\s*\{[^}]*\bSEAM_RETRY_AFTER_SECONDS\b[^}]*\}\s*from\s*'[./]*(?:backend\/)?db\/seamDenial'/.test(src),
    hardCoded: /'Retry-After'\s*,\s*['"`]?\d/.test(src),
  };
}

describe('every CAMPAIGN_LOOKUP_ERROR 503 carries Retry-After', () => {
  const files = execFileSync('git', ['grep', '-l', '--untracked', TOKEN, '--', 'backend', 'pages', 'lib'], { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => !/(^|\/)tests?\//.test(f) && !/\.test\.tsx?$/.test(f) && /\.tsx?$/.test(f))
    .sort();
  const scans = Object.fromEntries(files.map((rel) => [rel, scanCampaignLookup503(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'))]));
  const checked = Object.entries(scans).flatMap(([rel, s]) => s.sites.map((site) => `${rel}:${site.line}`));

  it('POSITIVE CONTROL: the scan finds the expected emitter files BY NAME, with the expected site count each', () => {
    const perFile = Object.fromEntries(Object.entries(scans).map(([rel, s]) => [rel, s.sites.length]));
    expect(perFile).toEqual(EXPECTED);
    // eslint-disable-next-line no-console
    console.log(`campaignLookupRetryAfter: checked ${checked.length} sites in ${files.length} files:\n  ${checked.join('\n  ')}`);
    expect(checked.length).toBeGreaterThanOrEqual(CONVERTED_IN_THIS_CHANGE);
  });

  it('each site sets Retry-After from SEAM_RETRY_AFTER_SECONDS in its own response block', () => {
    const missing = Object.entries(scans).flatMap(([rel, s]) => s.sites.filter((x) => !x.hasHeader).map((x) => `${rel}:${x.line}`));
    expect(missing).toEqual([]);
  });

  it('no CAMPAIGN_LOOKUP_ERROR occurrence is left unexplained (no emitter in another shape)', () => {
    const loose = Object.entries(scans).flatMap(([rel, s]) => s.unexplained.map((l) => `${rel}:${l}`));
    expect(loose).toEqual([]);
  });

  it('every emitter file imports SEAM_RETRY_AFTER_SECONDS from seamDenial and hard-codes no Retry-After value', () => {
    expect(Object.entries(scans).filter(([, s]) => !s.importsConstant).map(([rel]) => rel)).toEqual([]);
    expect(Object.entries(scans).filter(([, s]) => s.hardCoded).map(([rel]) => rel)).toEqual([]);
  });

  it('POSITIVE CONTROL: the scanner flags a missing header, a ternary 503, a nested-block header and a loose emitter', () => {
    const body = "{ error: 'x', code: 'CAMPAIGN_LOOKUP_ERROR', retryable: true }";
    const H = "res.setHeader('Retry-After', String(SEAM_RETRY_AFTER_SECONDS));";
    expect(scanCampaignLookup503('x.ts', `if (a) {\n  ${H}\n  return res.status(503).json(${body});\n}`).sites)
      .toEqual([{ line: 3, hasHeader: true }]);
    expect(scanCampaignLookup503('x.ts', `if (a) {\n  return res.status(503).json(${body});\n}`).sites)
      .toEqual([{ line: 2, hasHeader: false }]);
    expect(scanCampaignLookup503('x.ts', `${H}\nif (a) {\n  return b ? res.status(503).json(${body}) : res.status(404).json({});\n}`).sites)
      .toEqual([{ line: 3, hasHeader: false }]);
    expect(scanCampaignLookup503('x.ts', `if (a) {\n  if (b) { ${H} }\n  return res.status(503).json(${body});\n}`).sites)
      .toEqual([{ line: 3, hasHeader: false }]);
    const viaConst = scanCampaignLookup503('x.ts', `const B = ${body};\nif (a) return res.status(503).json(B);`);
    expect(viaConst.sites).toEqual([{ line: 2, hasHeader: false }]);
    expect(viaConst.unexplained).toEqual([]);
    expect(scanCampaignLookup503('x.ts', `res.statusCode = 503;\nres.json(${body});`).unexplained).toEqual([2]);
    expect(scanCampaignLookup503('x.ts', "res.setHeader('Retry-After', '5');").hardCoded).toBe(true);
  });
});
