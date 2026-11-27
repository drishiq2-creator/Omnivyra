// Adds disposition columns to the register and produces grouping statistics for report 07.
// Usage: node disposition.js <repo> <live-dir> <baseline-dir> <register.csv> <out-summary.json>
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const [repo, L, B, csvFile, outSummary] = process.argv.slice(2);

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  return rows;
}
const cellOut = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const [h, ...data] = parseCsv(fs.readFileSync(csvFile, 'utf8'));
const recs = data.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])));

// Runtime vs test/script code mentions (whole word), for every public table.
const files = execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n')
  .filter((f) => /\.(ts|tsx|js|jsx|cjs|mjs)$/.test(f)).filter((f) => !/(^|\/)\.env/.test(f)).filter((f) => !/(^|\/)(node_modules|\.next|dist|coverage)\//.test(f));
const isTest = (f) => /^(tests|backend\/tests|__tests__)\//.test(f) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(f);
const isScript = (f) => /^(scripts|db-utility|supabase)\//.test(f);
const names = new Set(recs.filter((r) => r.schema === 'public').map((r) => r.table));
const runtime = new Map(); const other = new Map();
for (const f of files) {
  let text; try { text = fs.readFileSync(path.join(repo, f), 'utf8'); } catch { continue; }
  const found = new Set(); for (const m of text.matchAll(/[A-Za-z0-9_]+/g)) if (names.has(m[0])) found.add(m[0]);
  if (found.size > 300) continue;
  const bucket = isTest(f) || isScript(f) ? other : runtime;
  for (const n of found) bucket.set(n, (bucket.get(n) || 0) + 1);
}

// Origins: corrected for the 6 formerly "E2E-only" tables.
const ORIGIN_FIX = {
  content_performance: 'repo migration 20260718000003_content_learning_performance.sql (on main; below ledgerMax, absent from baseline.sql)',
  content_prediction: 'repo migration 20260718000003_content_learning_performance.sql (on main; below ledgerMax, absent from baseline.sql)',
  learning_intelligence: 'repo migration 20260718000003_content_learning_performance.sql (on main; below ledgerMax, absent from baseline.sql)',
  learning_memory: 'repo migration 20260718000003_content_learning_performance.sql (on main; below ledgerMax, absent from baseline.sql)',
  prospect_lists: 'migration 20261127000000_pi_prospect_lists.sql (sha256 prefix 01315600d26291f7) on the unmerged stranded line only (latest 5ce2ced7f); NOT on main',
  prospect_list_members: 'migration 20261127000000_pi_prospect_lists.sql (sha256 prefix 01315600d26291f7) on the unmerged stranded line only (latest 5ce2ced7f); NOT on main',
};
const family = (n) => n.split('_')[0];
const famCount = {}; for (const n of names) famCount[family(n)] = (famCount[family(n)] || 0) + 1;

const ARCHIVE = new Set(['capability_audit_log', 'api_idempotency_keys']);
const out = [];
const summary = { totals: {}, dispositions: {}, unknownGroups: { byCanonical: {}, byRuntime: {}, byDbDependency: {}, byOrigin: {}, byFamily: {} } };
for (const r of recs) {
  const n = r.table;
  if (r.schema === 'public' && ORIGIN_FIX[n]) {
    r.origin = ORIGIN_FIX[n];
    if (r.classification === 'UNKNOWN') r.classification_reason = r.classification_reason.replace(/; ?not recreatable from the repository \(not in baseline or migrations\)|not recreatable from the repository \(not in baseline or migrations\); ?/, '');
  }
  const rt = r.schema === 'public' ? (runtime.get(n) || 0) : '';
  const ot = r.schema === 'public' ? (other.get(n) || 0) : '';
  const canonical = r.schema !== 'public' ? 'platform' : /NOT on main/.test(r.origin) ? 'no (stranded line only)' : 'yes';
  const dbDep = r.schema === 'public' ? [r.views_referencing ? 'view' : '', r.functions_mentioning ? 'function' : ''].filter(Boolean).join('+') || 'none' : 'platform';
  let disposition; let why;
  if (r.live_status === 'deleted') { disposition = 'DELETED'; why = 'UNUSED; dropped 2026-11-26 (report 06).'; }
  else if (r.schema !== 'public') { disposition = 'RETAIN (platform)'; why = 'Supabase-managed; never copied or dropped by this programme. Auth rows are test identities: EXCLUDE from any data migration.'; }
  else if (ARCHIVE.has(n)) { disposition = 'ARCHIVE then EXCLUDE'; why = n === 'capability_audit_log' ? 'Holds 3,211 append-only audit rows produced by the E2E auth suite (test identities only). Archive as evidence before E2E is decommissioned; never import into the production audit log.' : 'Holds 2 failed (HTTP 403) idempotency records from 2026-11-08/09 test traffic; no business value. Archive with the evidence set, exclude from migration.'; }
  else if (n === 'prospect_lists' || n === 'prospect_list_members') { disposition = 'RECREATE IN REPOSITORY'; why = 'Definition exists only on the unmerged stranded line (20261127000000_pi_prospect_lists.sql, identical column set to live E2E). Land it on main with the stranded line before relying on it; verify whether production already has it.'; }
  else if (['content_performance', 'content_prediction', 'learning_intelligence', 'learning_memory'].includes(n)) { disposition = 'RETAIN (canonical; baseline gap)'; why = 'Created by a main migration (20260718000003) with an identical column set; used by production code. Missing from baseline.sql, so CI replays never create it: regenerate the baseline or include this migration.'; }
  else { disposition = 'RETAIN schema; EXCLUDE data'; why = r.classification === 'ACTIVE' ? 'Used by the live auth suite until E2E is decommissioned; rows are test residue (currently empty).' : 'Canonical schema object, empty in E2E; production schema is the source of truth, so nothing is carried from E2E.'; }
  r.canonical_schema = canonical; r.runtime_code_files = rt; r.test_or_script_code_files = ot; r.db_dependency = dbDep; r.functional_family = r.schema === 'public' ? (famCount[family(n)] >= 5 ? family(n) : 'other') : r.schema;
  r.disposition = disposition; r.disposition_reason = why;
  summary.totals[r.classification] = (summary.totals[r.classification] || 0) + 1;
  summary.dispositions[disposition] = (summary.dispositions[disposition] || 0) + 1;
  if (r.classification === 'UNKNOWN') {
    const g = summary.unknownGroups;
    g.byCanonical[canonical] = (g.byCanonical[canonical] || 0) + 1;
    const rk = rt > 0 ? 'named by production runtime code' : ot > 0 ? 'named only by tests/scripts' : 'not named in code (config/other only)';
    g.byRuntime[rk] = (g.byRuntime[rk] || 0) + 1;
    g.byDbDependency[dbDep] = (g.byDbDependency[dbDep] || 0) + 1;
    const ok = r.origin.startsWith('repo baseline') ? 'baseline.sql' : r.origin.startsWith('repo migration 2027') || /^repo migration 20261/.test(r.origin) ? 'post-baseline migration' : r.origin.startsWith('repo migration 20260718000003') ? 'pre-ledgerMax migration (absent from baseline)' : r.origin.startsWith('migration 20261127') ? 'stranded line only' : r.origin;
    g.byOrigin[ok] = (g.byOrigin[ok] || 0) + 1;
    g.byFamily[r.functional_family] = (g.byFamily[r.functional_family] || 0) + 1;
  }
  out.push(r);
}
const header = [...h, 'canonical_schema', 'runtime_code_files', 'test_or_script_code_files', 'db_dependency', 'functional_family', 'disposition', 'disposition_reason'];
fs.writeFileSync(csvFile, [header, ...out.map((r) => header.map((k) => r[k]))].map((x) => x.map(cellOut).join(',')).join('\n') + '\n');
summary.unknownGroups.byFamily = Object.fromEntries(Object.entries(summary.unknownGroups.byFamily).sort((a, b) => b[1] - a[1]));
summary.unknownNoRuntimeNoDb = out.filter((r) => r.classification === 'UNKNOWN' && r.runtime_code_files === 0 && r.db_dependency === 'none').map((r) => `${r.table}(${r.test_or_script_code_files})`);
fs.writeFileSync(outSummary, JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ rows: out.length, totals: summary.totals, dispositions: summary.dispositions, unknown: { canonical: summary.unknownGroups.byCanonical, runtime: summary.unknownGroups.byRuntime, db: summary.unknownGroups.byDbDependency, origin: summary.unknownGroups.byOrigin }, topFamilies: Object.entries(summary.unknownGroups.byFamily).slice(0, 14), noRuntimeNoDb: summary.unknownNoRuntimeNoDb.length }, null, 1));
