// Regenerates 02-table-usage-register.csv from the LIVE E2E catalog (pre-cleanup snapshot = the full universe,
// post-cleanup snapshot = current state), merged with the static code evidence.
const fs = require('fs');
const path = require('path');
const [L, B, outCsv, outSummary] = process.argv.slice(2);
const r = (d, f) => JSON.parse(fs.readFileSync(path.join(L, d, f), 'utf8'))[0].result;
const preT = r('out', 'q03-public-tables.json');
const postNames = new Set(r('post', 'q03-public-tables.json').map((t) => t.table));
const fks = r('out', 'q04-fks.json');
const trg = r('out', 'q05-triggers.json');
const views = r('out', 'q06-view-deps.json') || [];
const fnm = new Map((r('out', 'q07-fn-mentions.json') || []).map((x) => [x.table, x.functions]));
const pols = r('out', 'q08-policies.json');
const platform = r('post', 'q12-platform-tables.json');
const cand = JSON.parse(fs.readFileSync(path.join(L, 'out', 'candidates.json'), 'utf8'));
const candRow = new Map(cand.rows.map((x) => [x.table, x]));
const dropped = new Set(cand.dropOrder);
const exportRows = new Map(r('out', 'q10-export-delete-set.json').map((x) => [x.table, x]));
const refs = JSON.parse(fs.readFileSync(path.join(B, 'refs.json'), 'utf8')).refs;
const baseline = new Set(JSON.parse(fs.readFileSync(path.join(B, 'baseline.json'), 'utf8')).tables.map((t) => t.name));
const post = new Map(JSON.parse(fs.readFileSync(path.join(B, 'post-baseline-tables.json'), 'utf8')).map((p) => [p.name, p.migration]));

const RUN = 'Hosted CI run 44932032061 (2026-11-21T17:52Z-17:56Z, all steps success) + live write statistics';
const ACTIVE = {
  users: ['ACT-02 suite via app; ACT-03 cleanup', 'SELECT, INSERT, UPDATE, DELETE', 'sync-supabase-user.ts:356; verify-email.ts:169; e2eIdentityCleanup.ts:130'],
  auth_sessions: ['ACT-02 suite via app', 'INSERT, SELECT, UPDATE', 'SessionAuthorityService.ts:167, :268'],
  capability_audit_log: ['ACT-02 suite via app; ACT-03 cleanup (count)', 'INSERT (append-only), SELECT count', 'SecurityAuditService.ts:148; e2eIdentityCleanup.ts:120'],
  stepup_sessions: ['ACT-02 (logout)', 'SELECT, UPDATE (normally 0 rows)', 'StepUpSessionService.ts:151; IdentityResolver.ts:173'],
  signup_intents: ['ACT-02 (verification)', 'SELECT, UPDATE (normally 0 rows)', 'signupEventService.ts:156; verify-email.ts:198'],
  user_company_roles: ['ACT-02', 'SELECT', 'post-login-route.ts:122; IdentityResolver.ts:75'],
  capability_assignments: ['ACT-02 (logout)', 'SELECT', 'CapabilityService.ts:64'],
  webauthn_credentials: ['ACT-02 (logout, re-login)', 'SELECT', 'IdentityResolver.ts:108'],
  totp_factors: ['ACT-02 (logout, re-login)', 'SELECT', 'IdentityResolver.ts:113'],
  trusted_devices: ['ACT-02 (logout)', 'SELECT', 'IdentityResolver.ts:224'],
};
const DEP = new Map(Object.entries({
  companies: 'FK target of users(active_company_id) and others; conditional schema probe (limit 0)',
  unified_persons: 'FK target of users(unified_person_id)',
  prospect_accounts: 'FK target of unified_persons',
  auth_audit_logs: 'Conditional path only (login rate limiter without Redis)',
  system_anomalies: 'Conditional path only (login rate limiter without Redis)',
  block_templates: 'NO ACTION FK to users: a referencing row would block the cleanup delete',
  campaign_cost_breakdown: 'NO ACTION FK to users: a referencing row would block the cleanup delete',
  company_join_requests: 'NO ACTION + CASCADE FKs to users',
  free_credit_claims: 'ON DELETE CASCADE child of users', free_credit_profiles: 'ON DELETE CASCADE child of users', intelligence_role_assignments: 'ON DELETE CASCADE child of users',
  opportunity_assignments: 'ON DELETE CASCADE child of users', recovery_codes: 'ON DELETE CASCADE child of users', report_automation_configs: 'ON DELETE CASCADE child of users',
  report_automation_events: 'ON DELETE CASCADE child of users', report_notification_events: 'ON DELETE CASCADE child of users', strategy_templates: 'ON DELETE CASCADE child of users',
  super_admin_audit_logs: 'ON DELETE CASCADE child of users (immutable-delete trigger)', user_preferences: 'ON DELETE CASCADE child of users', webauthn_challenges: 'ON DELETE CASCADE child of users',
  free_credit_unlocks: 'ON DELETE CASCADE child of auth.users', notifications: 'ON DELETE CASCADE child of auth.users', user_override: 'ON DELETE CASCADE child of auth.users',
}));
const HIST_DOC = { engagement_threads: 'ENG-004 one-off read-only count on E2E (docs/pmo/ENG-004-IMPLEMENTATION-REPORT.md:171-173)', engagement_messages: 'ENG-004 one-off read-only count on E2E (docs/pmo/ENG-004-IMPLEMENTATION-REPORT.md:171-173)' };

const inb = new Map(); const outb = new Map();
for (const k of fks) {
  const d = { O: 'NO ACTION', a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' }[k.on_delete] || k.on_delete;
  if (k.to_schema === 'public') (inb.get(k.to_table) ?? inb.set(k.to_table, []).get(k.to_table)).push(`${k.from_schema}.${k.from_table}(${d})`);
  if (k.from_schema === 'public') (outb.get(k.from_table) ?? outb.set(k.from_table, []).get(k.from_table)).push(`${k.to_schema}.${k.to_table}(${d})`);
}
const trgBy = new Map(); for (const t of trg) if (t.schema === 'public') (trgBy.get(t.table) ?? trgBy.set(t.table, []).get(t.table)).push(`${t.trigger}->${t.fn_schema}.${t.fn}`);
const viewBy = new Map(); for (const v of views) (viewBy.get(v.table) ?? viewBy.set(v.table, []).get(v.table)).push(`${v.view_schema}.${v.view}`);
const polCount = new Map(); for (const p of pols) polCount.set(p.table, (polCount.get(p.table) || 0) + 1);

const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const header = ['schema', 'table', 'live_status', 'origin', 'exact_rows_live', 'n_tup_ins', 'n_tup_upd', 'n_tup_del', 'seq_scan', 'idx_scan', 'owner', 'primary_key', 'foreign_keys_out', 'referencing_count', 'referencing', 'triggers', 'rls_enabled', 'rls_policy_count', 'views_referencing', 'functions_mentioning', 'grants', 'app_runtime_ref_files', 'script_ref_files', 'test_ref_files', 'code_text_mention_files', 'e2e_activities', 'e2e_operations', 'e2e_evidence', 'last_activity_evidence', 'classification', 'classification_reason', 'confidence', 'cleanup_action'];
const rows = []; const counts = { ACTIVE: 0, DEPENDENCY: 0, HISTORICAL: 0, UNUSED: 0, UNKNOWN: 0 };
const writes = (t) => Number(t.n_tup_ins) + Number(t.n_tup_upd) + Number(t.n_tup_del);
for (const t of [...preT].sort((a, b) => a.table.localeCompare(b.table))) {
  const n = t.table; const rf = refs[n] ?? { app: [], script: [], test: [] }; const c = candRow.get(n);
  const origin = baseline.has(n) ? 'repo baseline.sql' : post.has(n) ? `repo migration ${post.get(n)}` : 'E2E only (not in repository)';
  let cls; let reason; let conf; let acts = ''; let ops = ''; let ev = ''; let last = writes(t) ? `write activity recorded: ins ${t.n_tup_ins}, upd ${t.n_tup_upd}, del ${t.n_tup_del}` : 'no write activity recorded'; let action = 'retained';
  if (dropped.has(n)) {
    cls = 'UNUSED'; conf = 'HIGH'; action = 'DELETED 2026-11-26T14:36:56Z (DROP TABLE ... RESTRICT); definition exported to evidence/live-20261126/recovery-export-deleted-tables.json';
    reason = 'Empty (exact count 0, re-checked under lock), zero writes recorded, not named anywhere in tracked code/config, no view, function, policy or retained-table FK dependency, not ACTIVE/DEPENDENCY/HISTORICAL; recreatable from the repository.';
  } else if (ACTIVE[n]) {
    [acts, ops, ev] = ACTIVE[n]; cls = 'ACTIVE'; conf = 'HIGH'; last = `${RUN}: ${last}`;
    reason = 'Read/written by the live auth E2E suite or its cleanup (code path verified; live statistics agree).';
  } else if (DEP.has(n)) {
    cls = 'DEPENDENCY'; conf = 'HIGH'; reason = DEP.get(n);
  } else if (HIST_DOC[n] || writes(t) > 0 || Number(t.exact_rows) > 0) {
    cls = 'HISTORICAL'; conf = 'MEDIUM';
    reason = [HIST_DOC[n], writes(t) ? `live statistics show past writes (ins ${t.n_tup_ins}, upd ${t.n_tup_upd}, del ${t.n_tup_del}) since the 2026-11-08 refresh that no current activity explains (actor unknown)` : '', Number(t.exact_rows) ? `holds ${t.exact_rows} rows (retained; value of the data not assessed)` : ''].filter(Boolean).join('; ');
  } else {
    cls = 'UNKNOWN'; conf = 'MEDIUM';
    reason = `E2E copy is empty with no recorded writes, but it is not conclusively unused: ${(c?.retain_reasons || []).join('; ')}`;
  }
  counts[cls] += 1;
  rows.push(['public', n, dropped.has(n) ? 'deleted' : postNames.has(n) ? 'present' : 'MISSING', origin, t.exact_rows, t.n_tup_ins, t.n_tup_upd, t.n_tup_del, t.seq_scan, t.idx_scan, t.owner, t.pk || '',
    (outb.get(n) || []).join('; '), (inb.get(n) || []).length, (inb.get(n) || []).join('; '), (trgBy.get(n) || []).join('; '), t.rls ? 'yes' : 'no', polCount.get(n) || 0,
    (viewBy.get(n) || []).join('; '), (fnm.get(n) || []).join('; '), t.grants || '', rf.app.length, rf.script.length, rf.test.length, c ? c.code_mentions : '',
    acts, ops, ev, last, cls, reason, conf, action]);
}
// Platform-managed schemas: auth (used by the suite) and storage / realtime / vault (platform)
const AUTH_ACTIVE = { users: 'admin createUser/generateLink/listUsers/deleteUser; GoTrue sign-in, verify, sign-out', identities: 'created/removed with each auth user', sessions: 'GoTrue sessions from sign-in/verify; removed on sign-out/deleteUser', refresh_tokens: 'issued with each session', one_time_tokens: 'signup links from generateLink(signup)', mfa_amr_claims: 'authentication-method claims recorded per session' };
for (const p of platform) {
  const key = `${p.schema}.${p.table}`;
  let cls; let reason; let acts = ''; let ops = '';
  if (p.schema === 'auth' && AUTH_ACTIVE[p.table]) { cls = 'ACTIVE'; acts = 'ACT-02/ACT-03 (auth admin API and GoTrue)'; ops = AUTH_ACTIVE[p.table]; reason = `Supabase-managed auth table used by the suite; live statistics confirm (ins ${p.n_tup_ins}, del ${p.n_tup_del}).`; }
  else { cls = 'DEPENDENCY'; reason = `Supabase platform-managed (${p.schema}); required by the platform; never a cleanup candidate.${p.schema === 'auth' && p.table === 'audit_log_entries' ? ' Zero writes recorded: auth audit logging does not record in this project (correction to the Phase 2 inference).' : ''}`; }
  counts[cls] += 1;
  rows.push([p.schema, p.table, 'present', 'Supabase platform', `${p.n_live_tup} (statistics estimate)`, p.n_tup_ins, p.n_tup_upd, p.n_tup_del, '', '', p.owner, '', '', '', '', '', '', '', '', '', '', '', '', '', '', acts, ops, '', Number(p.n_tup_ins) ? `write activity recorded: ins ${p.n_tup_ins}` : 'no write activity recorded', cls, reason, 'HIGH', 'retained (platform)']);
  void key;
}
fs.writeFileSync(outCsv, [header, ...rows].map((x) => x.map(cell).join(',')).join('\n') + '\n');
const summary = { rows: rows.length, publicTables: preT.length, platformTables: platform.length, counts, dropped: [...dropped].sort(), historical: rows.filter((x) => x[29] === 'HISTORICAL').map((x) => `${x[0]}.${x[1]}`), absentPostBaseline: [...post.keys()].filter((n) => !preT.some((t) => t.table === n)), e2eOnly: preT.filter((t) => !baseline.has(t.table) && !post.has(t.table)).map((t) => t.table) };
fs.writeFileSync(outSummary, JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ rows: summary.rows, counts, historical: summary.historical.length, absent: summary.absentPostBaseline.length, e2eOnly: summary.e2eOnly.length, missing: rows.filter((x) => x[2] === 'MISSING').length }));
