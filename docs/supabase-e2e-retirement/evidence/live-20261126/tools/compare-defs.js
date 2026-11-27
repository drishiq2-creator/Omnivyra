// Compares column sets in migration CREATE TABLE blocks with the live E2E definitions.
// Usage: node compare-defs.js <live q14 json> <migration.sql> <table> [<table>...]
const fs = require('fs');
const [liveFile, sqlFile, ...tables] = process.argv.slice(2);
const sql = fs.readFileSync(sqlFile, 'utf8').replace(/\r\n/g, '\n');
const live = JSON.parse(fs.readFileSync(liveFile, 'utf8'))[0].result;
for (const t of tables) {
  const start = sql.search(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${t} \\(`));
  if (start < 0) { console.log(`${t}: CREATE TABLE not found in migration`); continue; }
  // walk to the matching close paren
  let depth = 0; let i = sql.indexOf('(', start); const open = i;
  for (; i < sql.length; i++) { if (sql[i] === '(') depth++; else if (sql[i] === ')') { depth--; if (depth === 0) break; } }
  const body = sql.slice(open + 1, i);
  const cols = body.split('\n').map((l) => l.replace(/--.*$/, '').trim()).filter((l) => /^[a-z_][a-z0-9_]* /.test(l) && !/^(constraint|primary|foreign|check|unique|exclude)\b/i.test(l)).map((l) => l.split(/\s+/)[0]);
  const lv = live.find((x) => x.table === t).columns.map((c) => c.name);
  const missingLive = cols.filter((c) => !lv.includes(c)); const extraLive = lv.filter((c) => !cols.includes(c));
  console.log(`${t}: migration ${cols.length} cols, live ${lv.length} cols, identical set: ${!missingLive.length && !extraLive.length}${missingLive.length ? `, only in migration: ${missingLive}` : ''}${extraLive.length ? `, only live: ${extraLive}` : ''}`);
}
