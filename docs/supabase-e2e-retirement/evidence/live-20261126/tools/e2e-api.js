// Management API client PINNED to the E2E project. It never prints the token.
//   node e2e-api.js get <path-under-project>            -> GET  /v1/projects/<E2E>/<path>
//   node e2e-api.js sql <sql-file> <out.json>             -> POST /v1/projects/<E2E>/database/query
// Every request URL is checked to start with the E2E project prefix; anything else is refused.
const fs = require('fs');
const E2E_REF = 'lomndxmrpyudaegddpef';
const PROD_REF = 'klkiseupptzbecbxwrky';
const BASE = `https://api.supabase.com/v1/projects/${E2E_REF}`;

let token = process.env.E2E_MGMT_TOKEN || '';
delete process.env.E2E_MGMT_TOKEN;
if (token.startsWith('go-keyring-base64:')) token = Buffer.from(token.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
token = token.trim();
if (!/^sbp_[A-Za-z0-9]+$/.test(token)) { console.error('token unavailable or not a Supabase personal access token (value not shown)'); process.exit(3); }

function guard(url) {
  if (!url.startsWith(BASE + '/') && url !== BASE) throw new Error('refused: URL outside the E2E project');
  if (url.includes(PROD_REF)) throw new Error('refused: production ref in URL');
}
async function call(method, url, body) {
  guard(url);
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, redirect: 'error' });
  const text = await res.text();
  return { status: res.status, text: text.split(token).join('[token]') };
}
(async () => {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === 'get') {
    const r = await call('GET', a ? `${BASE}/${a.replace(/^\//, '')}` : BASE);
    console.log(`HTTP ${r.status}`);
    console.log(r.text.slice(0, 20000));
    process.exit(r.status < 300 ? 0 : 1);
  }
  if (mode === 'sql') {
    const sql = fs.readFileSync(a, 'utf8');
    if (sql.includes(PROD_REF)) throw new Error('refused: production ref inside SQL text');
    const r = await call('POST', `${BASE}/database/query`, { query: sql });
    fs.writeFileSync(b, r.text);
    let rows = null;
    try { const j = JSON.parse(r.text); rows = Array.isArray(j) ? j.length : null; } catch { /* error body */ }
    console.log(`HTTP ${r.status}; rows=${rows}; bytes=${r.text.length}; saved=${b}`);
    if (r.status >= 300) console.log(r.text.slice(0, 2000));
    process.exit(r.status < 300 ? 0 : 1);
  }
  console.error('usage: get [path] | sql <file> <out>');
  process.exit(2);
})().catch((e) => { console.error(String(e && e.message ? e.message : e).split(token).join('[token]')); process.exit(1); });
