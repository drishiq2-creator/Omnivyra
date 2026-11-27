/**
 * Phase E - the extension request signature is verified over the EXACT request bytes.
 *
 * Before: requireExtensionAuth hashed JSON.stringify(req.body), a re-serialisation of Next's parse. The extension
 * (shared/requestSigner.js) hashes the string it sends. Each FRAGILE case below is first shown to be one where the
 * re-serialisation differs from the sent bytes (the control that the case is real - the old code would have
 * answered SIGNATURE_MISMATCH), then shown to verify now; a tampered body fails. Also pinned: the query string is
 * NOT signed (the client appends ?organization_id= after signing), and every route that reaches
 * requireExtensionAuth is wired for raw-body capture.
 */

process.env.EXTENSION_SESSION_SECRET = 'test-extension-session-secret-not-production';
delete process.env.DEV_EXTENSION_AUTH_BYPASS;

import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { createHash, createHmac, randomBytes } from 'crypto';

const mockNonces = new Set<string>();
const mockState = { rpcDown: false };
jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    rpc: async (fn: string, a: any) => {
      if (mockState.rpcDown) return { data: null, error: { message: 'down' } };
      if (fn !== 'extension_request_nonce_record') return { data: null, error: { message: 'unexpected' } };
      if (mockNonces.has(a.p_nonce_key)) return { data: false, error: null };
      mockNonces.add(a.p_nonce_key);
      return { data: true, error: null };
    },
    from: () => { throw new Error('no table reads expected'); },
  },
}));

import { requireExtensionAuth } from '../../middleware/extensionAuthMiddleware';
import { withExtensionRawBody } from '../../middleware/extensionRawBody';
import { issueExtensionSessionToken, deriveExtensionHmacSecret } from '../../services/extensionSessionService';

const SESSION = { userId: 'u-raw-1', orgId: 'o-raw-1', expiresAt: Date.now() + 3600_000, hmacNonce: 'hn-raw-1' };
const TOKEN = issueExtensionSessionToken(SESSION);
const SECRET = deriveExtensionHmacSecret({ ...SESSION, nonce: SESSION.hmacNonce });

/** requestSigner.js buildSignedHeaders: sha256 over the UTF-8 of the sent string. */
function sign(method: string, signedPath: string, sentBody: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const bodyHash = createHash('sha256').update(Buffer.from(sentBody || '', 'utf8')).digest('hex');
  const sig = createHmac('sha256', SECRET).update(`${method}\n${signedPath}\n${ts}\n${nonce}\n${bodyHash}`).digest('hex');
  return { 'x-omnivyra-timestamp': ts, 'x-omnivyra-nonce': nonce, 'x-omnivyra-signature': sig };
}

type Out = { status: number; body: any; seenBody?: unknown; authed: boolean };
async function send(opts: { method: string; url: string; wire: Buffer | string; headers: Record<string, string>; stream?: boolean }): Promise<Out> {
  const buf = Buffer.isBuffer(opts.wire) ? opts.wire : Buffer.from(opts.wire, 'utf8');
  const req: any = opts.stream === false ? {} : Readable.from(buf.length ? [buf] : []);
  if (opts.stream === false) req.body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
  Object.assign(req, { method: opts.method, url: opts.url, headers: { authorization: `Bearer ${TOKEN}`, ...opts.headers }, query: {} });
  const out: Out = { status: 0, body: undefined, authed: false };
  const res: any = {
    status: (c: number) => { out.status = c; return res; },
    json: (b: unknown) => { out.body = b; return res; },
    setHeader: () => res,
  };
  const handler = withExtensionRawBody(async (rq: any, rs: any) => {
    const a = await requireExtensionAuth(rq, rs);
    if (!a) return;
    out.authed = true;
    out.seenBody = rq.body;
    rs.status(200).json({ ok: true });
  });
  await handler(req, res);
  return out;
}

const JSON_CT = { 'content-type': 'application/json' };
const reserialised = (wire: string, ct = 'application/json') => {
  // what the old middleware hashed: JSON.stringify of Next's parse ('' for a falsy body)
  const parsed = ct === 'application/json' ? (wire.length === 0 ? {} : JSON.parse(wire)) : wire;
  return parsed ? JSON.stringify(parsed) : '';
};

beforeEach(() => { mockNonces.clear(); mockState.rpcDown = false; jest.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => jest.restoreAllMocks());

const FRAGILE: Array<{ name: string; wire: string; ct?: string }> = [
  { name: 'integer-like keys out of numeric order', wire: '{"2":"b","1":"a","commandId":"c1"}' },
  { name: 'empty POST body sent as application/json (serviceWorker.js: no body when data is null)', wire: '' },
  { name: 'escaped unicode', wire: '{"text":"caf\\u00e9 \\ud83d\\ude00"}' },
  { name: 'number spellings', wire: '{"n":1.0,"m":1e3,"k":-0}' },
  { name: 'whitespace', wire: '{ "a" : 1 }\n' },
  { name: 'text/plain string body', wire: 'plain text body', ct: 'text/plain' },
];

describe('previously fragile bodies verify over the raw bytes', () => {
  it.each(FRAGILE)('$name', async ({ wire, ct }) => {
    const contentType = ct ?? 'application/json';
    // control: the case is real - the re-serialisation is NOT the sent bytes
    expect(reserialised(wire, contentType)).not.toBe(wire);
    const r = await send({ method: 'POST', url: '/api/extension/validate', wire, headers: { 'content-type': contentType, ...sign('POST', '/api/extension/validate', wire) } });
    expect(r.status).toBe(200);
    expect(r.authed).toBe(true);
  });

  it('raw (unescaped) unicode verifies, and the handler still sees the parsed body', async () => {
    const wire = JSON.stringify({ text: 'Grüße – 日本語 😀', orgId: 'o-raw-1' });
    const r = await send({ method: 'POST', url: '/api/extension/validate', wire, headers: { ...JSON_CT, ...sign('POST', '/api/extension/validate', wire) } });
    expect(r.status).toBe(200);
    expect(r.seenBody).toEqual({ text: 'Grüße – 日本語 😀', orgId: 'o-raw-1' });
  });

  it('the empty JSON body is parsed to {} for the handler (Next semantics kept)', async () => {
    const r = await send({ method: 'POST', url: '/api/extension/validate', wire: '', headers: { ...JSON_CT, ...sign('POST', '/api/extension/validate', '') } });
    expect(r.status).toBe(200);
    expect(r.seenBody).toEqual({});
  });
});

describe('tampering fails', () => {
  it('one changed byte in the body -> SIGNATURE_MISMATCH (control: the untampered request passes)', async () => {
    const wire = '{"commandId":"c1","status":"ok"}';
    const headers = { ...JSON_CT, ...sign('POST', '/api/extension/validate', wire) };
    const ok = await send({ method: 'POST', url: '/api/extension/validate', wire, headers: { ...headers } });
    expect(ok.status).toBe(200);
    const tampered = await send({
      method: 'POST', url: '/api/extension/validate', wire: wire.replace('"ok"', '"OK"'),
      headers: { ...JSON_CT, ...sign('POST', '/api/extension/validate', wire) },
    });
    expect(tampered.status).toBe(401);
    expect(tampered.body).toMatchObject({ error: 'SIGNATURE_INVALID', reason: 'SIGNATURE_MISMATCH' });
  });

  it('a body that re-serialises to the signed string but differs on the wire is refused (old code accepted it)', async () => {
    const signedString = '{"a":1}';
    const wire = '{ "a" : 1 }';
    expect(reserialised(wire)).toBe(signedString); // the old path would have verified this
    const r = await send({ method: 'POST', url: '/api/extension/validate', wire, headers: { ...JSON_CT, ...sign('POST', '/api/extension/validate', signedString) } });
    expect(r.status).toBe(401);
    expect(r.body.reason).toBe('SIGNATURE_MISMATCH');
  });

  it('a signed path does not authorise another path', async () => {
    const r = await send({ method: 'POST', url: '/api/extension/health', wire: '{}', headers: { ...JSON_CT, ...sign('POST', '/api/extension/validate', '{}') } });
    expect(r.status).toBe(401);
  });
});

describe('query string: explicitly NOT covered (the client signs the pathname, then appends ?organization_id=)', () => {
  it('a GET signed for the pathname verifies with any query appended', async () => {
    const headers = sign('GET', '/api/extension/commands', '');
    const r = await send({ method: 'GET', url: '/api/extension/commands?organization_id=o-raw-1&x=1', wire: '', headers });
    expect(r.status).toBe(200);
  });

  it('control: signing the path WITH the query (what the client never does) does not verify', async () => {
    const headers = sign('GET', '/api/extension/commands?organization_id=o-raw-1', '');
    const r = await send({ method: 'GET', url: '/api/extension/commands?organization_id=o-raw-1', wire: '', headers });
    expect(r.status).toBe(401);
  });
});

describe('fail closed on wiring faults and store faults', () => {
  it('a POST whose bytes were not captured -> 500 RAW_BODY_UNAVAILABLE, never a re-serialisation (control: captured passes)', async () => {
    const wire = '{"a":1}';
    const headers = { ...JSON_CT, ...sign('POST', '/api/extension/validate', wire) };
    const r = await send({ method: 'POST', url: '/api/extension/validate', wire, headers, stream: false });
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('RAW_BODY_UNAVAILABLE');
    expect(r.authed).toBe(false);
    const ctl = await send({ method: 'POST', url: '/api/extension/validate', wire, headers: { ...JSON_CT, ...sign('POST', '/api/extension/validate', wire) } });
    expect(ctl.status).toBe(200);
  });

  it('invalid JSON on the wire -> 400 before auth (Next parity)', async () => {
    const r = await send({ method: 'POST', url: '/api/extension/validate', wire: '{bad', headers: { ...JSON_CT, ...sign('POST', '/api/extension/validate', '{bad') } });
    expect(r.status).toBe(400);
    expect(r.authed).toBe(false);
  });

  it('a body over 1 MB -> 413 (Next default sizeLimit kept)', async () => {
    const wire = JSON.stringify({ pad: 'x'.repeat(1024 * 1024) });
    const r = await send({ method: 'POST', url: '/api/extension/validate', wire, headers: { ...JSON_CT, ...sign('POST', '/api/extension/validate', wire) } });
    expect(r.status).toBe(413);
  });

  it('replay store down -> 503 REPLAY_STORE_UNAVAILABLE, not 401 (control: up -> 200)', async () => {
    mockState.rpcDown = true;
    const wire = '{}';
    const r = await send({ method: 'POST', url: '/api/extension/validate', wire, headers: { ...JSON_CT, ...sign('POST', '/api/extension/validate', wire) } });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('REPLAY_STORE_UNAVAILABLE');
    mockState.rpcDown = false;
    const ok = await send({ method: 'POST', url: '/api/extension/validate', wire, headers: { ...JSON_CT, ...sign('POST', '/api/extension/validate', wire) } });
    expect(ok.status).toBe(200);
  });
});

describe('wiring: every page route that reaches requireExtensionAuth captures the raw body', () => {
  const ROOT = path.resolve(__dirname, '../../..');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
  const pages = walk(path.join(ROOT, 'pages/api'));
  const SIGNED_HANDLERS = /requireExtensionAuth|apiHandlers\/salesNav\/extensionRoutes/;
  const signedRoutes = pages.filter((p) => SIGNED_HANDLERS.test(fs.readFileSync(p, 'utf8')));

  it('finds the signed routes (guard against an empty match)', () => {
    expect(signedRoutes.length).toBeGreaterThanOrEqual(17);
  });

  it.each(signedRoutes.map((p) => [path.relative(ROOT, p).replace(/\\/g, '/'), p]))('%s', (_rel, p) => {
    const src = fs.readFileSync(p as string, 'utf8');
    expect(src).toMatch(/^export const config = \{ api: \{ bodyParser: false \} \};$/m);
    expect(src).toMatch(/^export default __createApiRoute\(withExtensionRawBody\(handler\), /m);
  });
});
