// Pre vs post catalog diff. Every expected change must be explained by the 14 drops; anything else fails.
const fs = require('fs');
const path = require('path');
const [L] = process.argv.slice(2);
const r = (d, f) => JSON.parse(fs.readFileSync(path.join(L, d, f), 'utf8'))[0].result;
const dropped = new Set(JSON.parse(fs.readFileSync(path.join(L, 'out', 'candidates.json'), 'utf8')).dropOrder);
const out = { checks: [], pass: true };
const check = (name, ok, detail) => { out.checks.push({ name, ok, detail }); if (!ok) out.pass = false; };

const preT = r('out', 'q03-public-tables.json'); const postT = r('post', 'q03-public-tables.json');
const preN = new Set(preT.map((t) => t.table)); const postN = new Set(postT.map((t) => t.table));
const removed = [...preN].filter((n) => !postN.has(n)).sort(); const added = [...postN].filter((n) => !preN.has(n));
check('exactly the 14 deletion-set tables are gone', removed.length === 14 && removed.every((n) => dropped.has(n)), { removed });
check('no table added', added.length === 0, { added });
check('public table count 864 -> 850', preT.length === 864 && postT.length === 850, { pre: preT.length, post: postT.length });

const REQUIRED = ['users', 'auth_sessions', 'capability_audit_log', 'stepup_sessions', 'signup_intents', 'user_company_roles', 'capability_assignments', 'webauthn_credentials', 'totp_factors', 'trusted_devices',
  'companies', 'unified_persons', 'prospect_accounts', 'auth_audit_logs', 'system_anomalies', 'user_preferences', 'free_credit_claims', 'free_credit_profiles', 'free_credit_unlocks', 'notifications', 'user_override',
  'webauthn_challenges', 'recovery_codes', 'company_join_requests', 'block_templates', 'campaign_cost_breakdown', 'super_admin_audit_logs', 'intelligence_role_assignments', 'opportunity_assignments',
  'report_automation_configs', 'report_automation_events', 'report_notification_events', 'strategy_templates', 'engagement_threads', 'engagement_messages', 'api_idempotency_keys'];
check('every ACTIVE / DEPENDENCY / HISTORICAL / non-empty table is present', REQUIRED.every((n) => postN.has(n)), { missing: REQUIRED.filter((n) => !postN.has(n)) });

const rows = (ts) => Object.fromEntries(ts.map((t) => [t.table, Number(t.exact_rows)]));
const pr = rows(preT); const po = rows(postT);
const rowChanges = [...postN].filter((n) => pr[n] !== po[n]).map((n) => `${n}: ${pr[n]} -> ${po[n]}`);
check('row counts of retained tables unchanged (except live CI traffic on capability_audit_log)', rowChanges.every((c) => c.startsWith('capability_audit_log')), { rowChanges });

// FKs: post set must equal pre set minus FKs whose source or target was dropped
const fkKey = (k) => `${k.from_schema}.${k.from_table}|${k.name}`;
const preF = r('out', 'q04-fks.json'); const postF = r('post', 'q04-fks.json');
const expectedF = new Set(preF.filter((k) => !(k.from_schema === 'public' && dropped.has(k.from_table)) && !(k.to_schema === 'public' && dropped.has(k.to_table))).map(fkKey));
const postFS = new Set(postF.map(fkKey));
check('foreign keys = pre minus those owned by dropped tables (none lost from retained tables)', expectedF.size === postFS.size && [...expectedF].every((k) => postFS.has(k)), { pre: preF.length, expected: expectedF.size, post: postFS.size, removedFromDropped: preF.length - expectedF.size });
check('no dropped table was the TARGET of any foreign key', preF.filter((k) => k.to_schema === 'public' && dropped.has(k.to_table)).length === 0, {});

const trgKey = (t) => `${t.schema}.${t.table}.${t.trigger}`;
const preTr = r('out', 'q05-triggers.json'); const postTr = r('post', 'q05-triggers.json');
const expTr = preTr.filter((t) => !(t.schema === 'public' && dropped.has(t.table)));
check('triggers = pre minus those on dropped tables', expTr.length === postTr.length && expTr.every((t) => postTr.some((p) => trgKey(p) === trgKey(t))), { pre: preTr.length, post: postTr.length, removed: preTr.filter((t) => t.schema === 'public' && dropped.has(t.table)).map(trgKey) });

const polKey = (p) => `${p.table}.${p.policy}`;
const preP = r('out', 'q08-policies.json'); const postP = r('post', 'q08-policies.json');
const expP = preP.filter((p) => !dropped.has(p.table));
check('policies = pre minus those on dropped tables', expP.length === postP.length && expP.every((p) => postP.some((q) => polKey(q) === polKey(p))), { pre: preP.length, post: postP.length, removed: preP.filter((p) => dropped.has(p.table)).map(polKey) });

const preV = JSON.stringify(r('out', 'q06-view-deps.json')); const postV = JSON.stringify(r('post', 'q06-view-deps.json'));
check('view dependencies identical', preV === postV, {});
const preFn = JSON.stringify(r('out', 'q07-fn-mentions.json')); const postFn = JSON.stringify(r('post', 'q07-fn-mentions.json'));
check('function-to-table mentions identical', preFn === postFn, {});

const preS = r('out', 'q02-schemas.json'); const postS = r('post', 'q02-schemas.json');
const sch = (s) => Object.fromEntries(s.schemas.map((x) => [x.schema, x]));
const a = sch(preS); const b = sch(postS);
check('function and view counts unchanged in every schema', Object.keys(a).every((k) => b[k] && a[k].functions === b[k].functions && a[k].views === b[k].views), { public: { pre: a.public, post: b.public } });
check('non-public schemas untouched (table counts)', Object.keys(a).filter((k) => k !== 'public').every((k) => a[k].tables === b[k].tables), {});
check('extensions, publications and event triggers unchanged', JSON.stringify([preS.extensions, preS.publications, preS.event_triggers]) === JSON.stringify([postS.extensions, postS.publications, postS.event_triggers]), {});
const p9a = r('out', 'q09-platform.json'); const p9b = r('post', 'q09-platform.json');
// json_agg without ORDER BY has no defined order: compare the trigger lists as sorted sets.
const trgSet = (x) => JSON.stringify(x.auth_storage_triggers.map((t) => `${t.schema}.${t.table}.${t.trigger}>${t.fn}`).sort());
check('auth / storage / cron state unchanged', JSON.stringify([p9a.auth_counts, p9a.storage_buckets, p9a.storage_objects, p9a.cron_schema, p9a.public_fks_to_auth]) === JSON.stringify([p9b.auth_counts, p9b.storage_buckets, p9b.storage_objects, p9b.cron_schema, p9b.public_fks_to_auth]) && trgSet(p9a) === trgSet(p9b), { authUsers: p9b.auth_counts.users, triggers: p9b.auth_storage_triggers.length });
fs.writeFileSync(path.join(L, 'post', 'verification.json'), JSON.stringify(out, null, 1));
for (const c of out.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${JSON.stringify(c.detail).slice(0, 300)}`);
console.log(out.pass ? 'ALL CHECKS PASS' : 'VERIFICATION FAILED');
