// Renders the generated sections of 03 and 04 from the live register CSV.
const fs = require('fs');
const [csvFile, outActive, outUnused] = process.argv.slice(2);
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  return rows;
}
const [h, ...data] = parseCsv(fs.readFileSync(csvFile, 'utf8'));
const recs = data.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])));
const md = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const by = (c) => recs.filter((r) => r.classification === c);
let a = '| # | Table | Live rows | Writes recorded (ins / upd / del) | E2E activity | Operations | Code evidence | Confidence |\n|---|---|---|---|---|---|---|---|\n';
by('ACTIVE').forEach((r, i) => { a += `| ${i + 1} | \`${r.schema}.${r.table}\` | ${md(r.exact_rows_live)} | ${r.n_tup_ins} / ${r.n_tup_upd} / ${r.n_tup_del} | ${md(r.e2e_activities)} | ${md(r.e2e_operations)} | ${md(r.e2e_evidence) || 'Supabase Auth (GoTrue)'} | ${r.confidence} |\n`; });
const depPub = by('DEPENDENCY').filter((r) => r.schema === 'public');
const depPlat = by('DEPENDENCY').filter((r) => r.schema !== 'public');
a += `\n## DEPENDENCY tables (${by('DEPENDENCY').length}: ${depPub.length} public + ${depPlat.length} platform-managed)\n\n| # | Table | Live rows | Why it is a dependency | Confidence |\n|---|---|---|---|---|\n`;
depPub.forEach((r, i) => { a += `| ${i + 1} | \`public.${r.table}\` | ${r.exact_rows_live} | ${md(r.classification_reason)} | ${r.confidence} |\n`; });
const grp = {}; for (const r of depPlat) (grp[r.schema] ??= []).push(`\`${r.table}\``);
a += `\nPlatform-managed (Supabase; never cleanup candidates): ${Object.entries(grp).map(([s, l]) => `**${s}** (${l.length}): ${l.join(', ')}`).join('; ')}.\n`;
a += `\n## HISTORICAL tables (${by('HISTORICAL').length})\n\n| # | Table | Live rows | Writes recorded (ins / upd / del) | Evidence | Confidence |\n|---|---|---|---|---|---|\n`;
by('HISTORICAL').forEach((r, i) => { a += `| ${i + 1} | \`public.${r.table}\` | ${r.exact_rows_live} | ${r.n_tup_ins} / ${r.n_tup_upd} / ${r.n_tup_del} | ${md(r.classification_reason)} | ${r.confidence} |\n`; });
fs.writeFileSync(outActive, a);

let u = `## Deleted UNUSED tables (${by('UNUSED').length})\n\n| # | Table | Prior exact rows | Writes recorded | Origin (recovery source) | Evidence | Action |\n|---|---|---|---|---|---|---|\n`;
by('UNUSED').forEach((r, i) => { u += `| ${i + 1} | \`public.${r.table}\` | ${r.exact_rows_live} | ${r.n_tup_ins} / ${r.n_tup_upd} / ${r.n_tup_del} | ${md(r.origin)} | ${md(r.classification_reason)} | ${md(r.cleanup_action)} |\n`; });
const unk = by('UNKNOWN');
const tally = {};
for (const r of unk) {
  const reasons = r.classification_reason.replace(/^.*?not conclusively unused: /, '').split('; ');
  for (const why of reasons) { const k = why.replace(/[0-9]+/g, 'N').replace(/:.*/, ''); tally[k] = (tally[k] || 0) + 1; }
}
u += `\n## Retained as UNKNOWN (${unk.length}): empty, no recorded writes, but not conclusively unused\n\nEvery one of these E2E tables is empty and shows no write activity. Each is retained because at least one of the following holds; one table can match several.\n\n| Retention reason | Tables |\n|---|---|\n`;
for (const [k, v] of Object.entries(tally).sort((x, y) => y[1] - x[1])) u += `| ${md(k)} | ${v} |\n`;
u += '\nThe per-table reasons are in `02-table-usage-register.csv` (`classification_reason`).\n';
fs.writeFileSync(outUnused, u);
console.log(JSON.stringify({ active: by('ACTIVE').length, dependency: by('DEPENDENCY').length, historical: by('HISTORICAL').length, unused: by('UNUSED').length, unknown: unk.length, tally }));
