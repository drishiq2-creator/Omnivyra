// Computes the deletion set for the live E2E public schema. Every criterion is evaluated per table and recorded.
// Usage: node candidates.js <live-out-dir> <repo> <baseline-dir> <out.json>
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const [O, repo, B, outFile] = process.argv.slice(2);
const r = (f) => JSON.parse(fs.readFileSync(path.join(O, f), 'utf8'))[0].result;
const tables = r('q03-public-tables.json');
const fks = r('q04-fks.json') || [];
const viewDeps = r('q06-view-deps.json') || [];
const fnMentions = r('q07-fn-mentions.json') || [];
const policies = r('q08-policies.json') || [];
const baseline = JSON.parse(fs.readFileSync(path.join(B, 'baseline.json'), 'utf8'));
const inBaseline = new Set(baseline.tables.map((t) => t.name));
const post = new Map(JSON.parse(fs.readFileSync(path.join(B, 'post-baseline-tables.json'), 'utf8')).map((p) => [p.name, p.migration]));
const names = tables.map((t) => t.name ?? t.table);

// Earlier static classification (phase 2): ACTIVE / DEPENDENCY / HISTORICAL
const PROTECTED = new Set(['users', 'auth_sessions', 'capability_audit_log', 'stepup_sessions', 'signup_intents', 'user_company_roles', 'capability_assignments', 'webauthn_credentials', 'totp_factors', 'trusted_devices',
  'auth_audit_logs', 'block_templates', 'campaign_cost_breakdown', 'companies', 'company_join_requests', 'free_credit_claims', 'free_credit_profiles', 'free_credit_unlocks', 'intelligence_role_assignments', 'notifications', 'opportunity_assignments', 'prospect_accounts', 'recovery_codes', 'report_automation_configs', 'report_automation_events', 'report_notification_events', 'strategy_templates', 'super_admin_audit_logs', 'system_anomalies', 'unified_persons', 'user_override', 'user_preferences', 'webauthn_challenges',
  'engagement_threads', 'engagement_messages']);

// ---- Code text mentions (conservative: any word-boundary occurrence in tracked code/config) ----
const files = execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n')
  .filter((f) => /\.(ts|tsx|js|jsx|cjs|mjs|sql|sh|ps1|py|ya?ml|json|toml)$/.test(f))
  .filter((f) => !/(^|\/)\.env/.test(f))
  .filter((f) => !/^supabase\/(migrations|_schema)\//.test(f)) // schema history defines tables; it is not usage
  .filter((f) => !/(^|\/)(node_modules|\.next|dist|coverage)\//.test(f));
const nameSet = new Set(names);
const mentions = new Map(names.map((n) => [n, []]));
const generatedMirrors = [];
for (const f of files) {
  let text; try { text = fs.readFileSync(path.join(repo, f), 'utf8'); } catch { continue; }
  const found = new Set();
  for (const m of text.matchAll(/[A-Za-z0-9_]+/g)) if (nameSet.has(m[0])) found.add(m[0]);
  if (found.size > 300) { generatedMirrors.push({ file: f, distinctTables: found.size }); continue; } // a schema mirror (e.g. generated DB types), not usage
  for (const n of found) mentions.get(n).push(f);
}

// ---- Database dependencies ----
const byName = new Map(tables.map((t) => [t.table, t]));
const viewDep = new Map(); for (const v of viewDeps) (viewDep.get(v.table) ?? viewDep.set(v.table, []).get(v.table)).push(`${v.view_schema}.${v.view}`);
const fnDep = new Map(fnMentions.map((x) => [x.table, x.functions]));
const policyDep = new Map();
for (const p of policies) {
  const text = `${p.qual ?? ''} ${p.with_check ?? ''}`;
  for (const m of text.matchAll(/[A-Za-z0-9_]+/g)) if (nameSet.has(m[0]) && m[0] !== p.table) (policyDep.get(m[0]) ?? policyDep.set(m[0], new Set()).get(m[0])).add(`${p.table}.${p.policy}`);
}
const inbound = new Map(); const outbound = new Map();
for (const k of fks) {
  if (k.to_schema === 'public') (inbound.get(k.to_table) ?? inbound.set(k.to_table, []).get(k.to_table)).push(k);
  if (k.from_schema === 'public') (outbound.get(k.from_table) ?? outbound.set(k.from_table, []).get(k.from_table)).push(k);
}

// ---- Evaluate (two passes: inbound FKs must come only from other deletion candidates) ----
const evalRow = (n) => {
  const t = byName.get(n);
  const reasons = [];
  if (Number(t.exact_rows) !== 0) reasons.push(`has ${t.exact_rows} rows`);
  if (Number(t.n_tup_ins) || Number(t.n_tup_upd) || Number(t.n_tup_del)) reasons.push(`write activity recorded (ins ${t.n_tup_ins}, upd ${t.n_tup_upd}, del ${t.n_tup_del})`);
  if (PROTECTED.has(n)) reasons.push('ACTIVE/DEPENDENCY/HISTORICAL in the static register');
  if (mentions.get(n).length) reasons.push(`named in ${mentions.get(n).length} tracked code/config file(s)`);
  if (viewDep.has(n)) reasons.push(`view dependency: ${viewDep.get(n).join(', ')}`);
  if (fnDep.has(n)) reasons.push(`mentioned in function body: ${fnDep.get(n).join(', ')}`);
  if (policyDep.has(n)) reasons.push(`mentioned by policy on another table: ${[...policyDep.get(n)].join(', ')}`);
  if (!inBaseline.has(n) && !post.has(n)) reasons.push('not recreatable from the repository (not in baseline or migrations)');
  return reasons;
};
let cand = new Set(names.filter((n) => evalRow(n).length === 0));
for (let changed = true; changed;) {
  changed = false;
  for (const n of [...cand]) {
    const bad = (inbound.get(n) || []).filter((k) => !(k.from_schema === 'public' && cand.has(k.from_table)) || k.from_schema !== 'public');
    if (bad.length) { cand.delete(n); changed = true; }
  }
}
const rows = names.map((n) => {
  const t = byName.get(n);
  const reasons = evalRow(n);
  if (!reasons.length && !cand.has(n)) reasons.push(`inbound FK from a retained table: ${(inbound.get(n) || []).filter((k) => !cand.has(k.from_table)).map((k) => `${k.from_schema}.${k.from_table}`).join(', ')}`);
  return { table: n, rows: Number(t.exact_rows), n_tup_ins: t.n_tup_ins, n_tup_upd: t.n_tup_upd, n_tup_del: t.n_tup_del, in_baseline: inBaseline.has(n), post_migration: post.get(n) || null,
    code_mentions: mentions.get(n).length, inbound_fks: (inbound.get(n) || []).length, outbound_fks: (outbound.get(n) || []).length, triggers: null,
    delete: cand.has(n), retain_reasons: reasons };
});
// Topological drop order among candidates: a table is dropped after every candidate that references it.
const order = []; const done = new Set();
const visit = (n, stack = new Set()) => {
  if (done.has(n)) return; if (stack.has(n)) throw new Error('FK cycle among candidates at ' + n); stack.add(n);
  for (const k of inbound.get(n) || []) if (k.from_schema === 'public' && cand.has(k.from_table) && k.from_table !== n) visit(k.from_table, stack);
  stack.delete(n); done.add(n); order.push(n);
};
for (const n of [...cand].sort()) visit(n);
fs.writeFileSync(outFile, JSON.stringify({ liveTables: names.length, deleteCount: cand.size, dropOrder: order, generatedMirrors, rows }, null, 1));
const tally = {}; for (const x of rows) if (!x.delete) for (const why of x.retain_reasons) { const k = why.replace(/[0-9]+/g, 'N').replace(/:.*/, ''); tally[k] = (tally[k] || 0) + 1; }
console.log(JSON.stringify({ liveTables: names.length, notInBaseline: names.filter((n) => !inBaseline.has(n)).length, postBaselinePresent: names.filter((n) => post.has(n)).length, baselineMissingLive: [...inBaseline].filter((n) => !nameSet.has(n)), deleteCount: cand.size, generatedMirrors, retainReasonTally: tally }, null, 1));
