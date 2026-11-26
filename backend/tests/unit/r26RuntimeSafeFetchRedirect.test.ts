/**
 * Round 26 / S-8 + T-14 — safeFetch credential containment (policy rule P5).
 *
 *   - a CROSS-ORIGIN redirect hop carries no Authorization / Cookie / X-Api-Key /
 *     X-Webhook-* / signature / caller-declared credential header;
 *   - a SAME-ORIGIN hop keeps them (positive control);
 *   - 301/302/303 on POST become a body-less GET; 307/308 keep method + body;
 *   - a credentialed request is refused over plain http (every hop), except loopback;
 *   - uncredentialed http with allowHttp is unchanged (caller compatibility).
 *
 * DNS + undici are mocked exactly like safeFetch.test.ts (no network).
 *
 * FAILING CONTROL (recorded in the round-26 report): at origin/main 2bc52db7a the
 * second hop receives the same `init` (Authorization etc. re-sent to the new origin),
 * a POST stays a POST with its body after 302, and http with a credential is fetched.
 */
const mockLookup = jest.fn();
jest.mock('dns', () => ({ promises: { lookup: (...a: unknown[]) => mockLookup(...a) } }));
const mockUndiciFetch = jest.fn();
jest.mock('undici', () => ({
  Agent: jest.fn().mockImplementation(() => ({ close: jest.fn() })),
  fetch: (...a: unknown[]) => mockUndiciFetch(...a),
}));

import { safeFetch, SsrfBlockedError, isCredentialHeaderName, isLoopbackHost, isDevLoopbackHttpAllowed, isCredentialQueryParamName } from '../../../lib/security/safeFetch';

function res(status: number, headers: Record<string, string> = {}): Response {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status, url: '',
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    body: { cancel: async () => undefined, getReader: () => ({ read: async () => ({ done: true }), cancel: async () => undefined, releaseLock: () => undefined }) },
  } as unknown as Response;
}

const SECRET_HEADERS = {
  Authorization: 'Bearer FAKE-tenant-wp-app-password-r26',
  Cookie: 'session=FAKE-cookie-r26',
  'X-Api-Key': 'FAKE-x-api-key-r26',
  'X-Webhook-Secret': 'FAKE-webhook-secret-r26',
  'X-Hub-Signature-256': 'sha256=FAKEsig',
  'X-Custom-Cred': 'FAKE-custom-r26',
};
const SECRET_VALUES = Object.values(SECRET_HEADERS);
const hopHeaders = (i: number): Record<string, string> => {
  const init = mockUndiciFetch.mock.calls[i][1] as RequestInit;
  const out: Record<string, string> = {};
  const h = init.headers as unknown;
  if (!h) return out;
  if (Array.isArray(h)) for (const [k, v] of h as [string, string][]) out[k.toLowerCase()] = v;
  else if (h instanceof Headers) h.forEach((v, k) => { out[k.toLowerCase()] = v; });
  else for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = v;
  return out;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('cross-origin redirect strips credentials', () => {
  it('302 to another origin: the second hop carries NO credential header', async () => {
    mockUndiciFetch
      .mockResolvedValueOnce(res(302, { location: 'https://other.example/landing' }))
      .mockResolvedValueOnce(res(200));
    await safeFetch('https://wp.tenant.example/wp-json/wp/v2/posts', { headers: { ...SECRET_HEADERS, Accept: 'application/json' } }, { credentialHeaders: ['X-Custom-Cred'] });
    expect(mockUndiciFetch).toHaveBeenCalledTimes(2);           // scenario exists
    const first = JSON.stringify(mockUndiciFetch.mock.calls[0][1]);
    for (const v of SECRET_VALUES) expect(first).toContain(v);   // first hop unchanged
    const second = JSON.stringify(mockUndiciFetch.mock.calls[1][1]);
    for (const v of SECRET_VALUES) expect(second).not.toContain(v);
    expect(hopHeaders(1).accept).toBe('application/json');        // non-credential headers kept
  });

  it('works for Headers instances and header arrays too', async () => {
    for (const headers of [new Headers({ Authorization: 'Bearer FAKE-h-r26' }), [['Authorization', 'Bearer FAKE-h-r26']] as [string, string][]]) {
      mockUndiciFetch.mockReset();
      mockUndiciFetch
        .mockResolvedValueOnce(res(307, { location: 'https://other.example/x' }))
        .mockResolvedValueOnce(res(200));
      await safeFetch('https://a.example/x', { headers });
      expect(hopHeaders(0).authorization).toBe('Bearer FAKE-h-r26'); // control: present on hop 1
      expect(hopHeaders(1).authorization).toBeUndefined();
    }
  });

  it('POSITIVE CONTROL: a same-origin redirect keeps the credential', async () => {
    mockUndiciFetch
      .mockResolvedValueOnce(res(302, { location: '/v2/posts?page=2' }))
      .mockResolvedValueOnce(res(200));
    await safeFetch('https://api.provider.example/v2/posts', { headers: { Authorization: 'Bearer FAKE-same-origin-r26' } });
    expect(hopHeaders(1).authorization ?? JSON.stringify(mockUndiciFetch.mock.calls[1][1])).toContain('FAKE-same-origin-r26');
  });

  it('a different PORT or scheme is a different origin', async () => {
    mockUndiciFetch
      .mockResolvedValueOnce(res(301, { location: 'https://api.provider.example:8443/x' }))
      .mockResolvedValueOnce(res(200));
    await safeFetch('https://api.provider.example/x', { headers: { Authorization: 'Bearer FAKE-port-r26' } });
    expect(JSON.stringify(mockUndiciFetch.mock.calls[1][1])).not.toContain('FAKE-port-r26');
  });
});

describe('redirect method semantics', () => {
  it.each([301, 302, 303])('%s after POST → body-less GET, body headers dropped', async (status) => {
    mockUndiciFetch
      .mockResolvedValueOnce(res(status, { location: '/done' }))
      .mockResolvedValueOnce(res(200));
    await safeFetch('https://api.provider.example/submit', {
      method: 'POST', body: '{"lead":"FAKE-body-r26"}', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
    const hop = mockUndiciFetch.mock.calls[1][1] as RequestInit;
    expect(hop.method).toBe('GET');
    expect('body' in hop).toBe(false);
    expect(hopHeaders(1)['content-type']).toBeUndefined();
    expect(hopHeaders(1).accept).toBe('application/json');
  });

  it.each([307, 308])('%s keeps method and body', async (status) => {
    mockUndiciFetch
      .mockResolvedValueOnce(res(status, { location: '/v2/submit' }))
      .mockResolvedValueOnce(res(200));
    await safeFetch('https://api.provider.example/submit', { method: 'POST', body: 'FAKE-body-r26' });
    const hop = mockUndiciFetch.mock.calls[1][1] as RequestInit;
    expect(hop.method).toBe('POST');
    expect(hop.body).toBe('FAKE-body-r26');
  });

  it('a GET is unchanged by a 302', async () => {
    mockUndiciFetch.mockResolvedValueOnce(res(302, { location: '/x' })).mockResolvedValueOnce(res(200));
    await safeFetch('https://api.provider.example/a', { method: 'GET' });
    expect((mockUndiciFetch.mock.calls[1][1] as RequestInit).method).toBe('GET');
  });
});

describe('plain http', () => {
  it('a credentialed request over http is refused before DNS or any byte is sent', async () => {
    await expect(safeFetch('http://legacy.provider.example/api', { headers: { 'X-Api-Key': 'FAKE-http-r26' } }, { allowHttp: true }))
      .rejects.toMatchObject({ reason: 'credential_over_plain_http' });
    expect(mockUndiciFetch).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('an https → http downgrade redirect cannot carry the credential (stripped cross-origin)', async () => {
    mockUndiciFetch
      .mockResolvedValueOnce(res(302, { location: 'http://wp.tenant.example/login' }))
      .mockResolvedValueOnce(res(200));
    await safeFetch('https://wp.tenant.example/wp-json', { headers: { Authorization: 'Basic FAKE-downgrade-r26' } }, { allowHttp: true });
    expect(JSON.stringify(mockUndiciFetch.mock.calls[1][1])).not.toContain('FAKE-downgrade-r26');
  });

  it('COMPAT: uncredentialed http with allowHttp still works (site probing callers)', async () => {
    mockUndiciFetch.mockResolvedValueOnce(res(200));
    await safeFetch('http://plain.tenant.example/', {}, { allowHttp: true });
    expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
  });

  it('loopback dev allowance: a credential may reach localhost over http (with allowHttp + allowPrivateNetwork)', async () => {
    mockUndiciFetch.mockResolvedValueOnce(res(200));
    await safeFetch('http://localhost:3000/api', { headers: { Authorization: 'Bearer FAKE-dev-r26' } }, { allowHttp: true, allowPrivateNetwork: true });
    expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
  });

  it('the refusal error never contains the credential', async () => {
    const err = await safeFetch('http://legacy.provider.example/api?x=1', { headers: { Authorization: 'Bearer FAKE-err-r26' } }, { allowHttp: true })
      .catch((e: unknown) => e as SsrfBlockedError);
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect(String((err as Error).message)).not.toContain('FAKE-err-r26');
  });
});

// Round 26 FINAL — owner decision on plain http.
// FAILING CONTROLS: at origin/main 2bc52db7a prod + http://localhost (with allowHttp +
// allowPrivateNetwork) is fetched, a credentialed http:// external request is fetched, and
// isDevLoopbackHttpAllowed does not exist. Against the first r26-e cut, prod + localhost was
// also fetched (the loopback allowance was unconditional).
describe('owner decision: loopback http only in explicit dev/test', () => {
  const savedEnv = { NODE_ENV: process.env.NODE_ENV, FLAG: process.env.SAFE_FETCH_ALLOW_LOOPBACK_HTTP };
  const setEnv = (nodeEnv: string | undefined, flag?: string) => {
    const env = process.env as Record<string, string | undefined>;
    if (nodeEnv === undefined) delete env.NODE_ENV; else env.NODE_ENV = nodeEnv;
    if (flag === undefined) delete env.SAFE_FETCH_ALLOW_LOOPBACK_HTTP; else env.SAFE_FETCH_ALLOW_LOOPBACK_HTTP = flag;
  };
  afterEach(() => setEnv(savedEnv.NODE_ENV, savedEnv.FLAG));
  const LOOP_OPTS = { allowHttp: true, allowPrivateNetwork: true };

  it('production + http://localhost is refused (credentialed AND uncredentialed), before any request', async () => {
    setEnv('production');
    await expect(safeFetch('http://localhost:3000/api', { headers: { Authorization: 'Bearer FAKE-prod-loop' } }, LOOP_OPTS))
      .rejects.toMatchObject({ reason: 'loopback_http_not_allowed' });
    await expect(safeFetch('http://127.0.0.1:8080/', {}, LOOP_OPTS)).rejects.toMatchObject({ reason: 'loopback_http_not_allowed' });
    expect(mockUndiciFetch).not.toHaveBeenCalled();
  });

  it('production: the opt-in flag is REFUSED', async () => {
    setEnv('production', '1');
    await expect(safeFetch('http://localhost:3000/api', {}, LOOP_OPTS)).rejects.toMatchObject({ reason: 'loopback_http_not_allowed' });
    expect(isDevLoopbackHttpAllowed()).toBe(false);
  });

  it('test env + localhost is allowed', async () => {
    setEnv('test');
    mockUndiciFetch.mockResolvedValueOnce(res(200));
    await safeFetch('http://localhost:3000/api', { headers: { Authorization: 'Bearer FAKE-test-loop' } }, LOOP_OPTS);
    expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
  });

  it('development env allowed; any other env only with the explicit opt-in flag', () => {
    expect(isDevLoopbackHttpAllowed({ NODE_ENV: 'development' } as any)).toBe(true);
    expect(isDevLoopbackHttpAllowed({ NODE_ENV: 'staging' } as any)).toBe(false);
    expect(isDevLoopbackHttpAllowed({} as any)).toBe(false);
    expect(isDevLoopbackHttpAllowed({ NODE_ENV: 'staging', SAFE_FETCH_ALLOW_LOOPBACK_HTTP: '1' } as any)).toBe(true);
    expect(isDevLoopbackHttpAllowed({ NODE_ENV: 'production', SAFE_FETCH_ALLOW_LOOPBACK_HTTP: 'true' } as any)).toBe(false);
  });

  it('production + https external with a credential is allowed (positive control)', async () => {
    setEnv('production');
    mockUndiciFetch.mockResolvedValueOnce(res(200));
    await safeFetch('https://api.provider.example/v1', { headers: { Authorization: 'Bearer FAKE-https' } });
    expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
  });

  it('production + credentialed http:// external (webhook) is refused', async () => {
    setEnv('production');
    await expect(safeFetch('http://hooks.tenant.example/in', { method: 'POST', headers: { 'X-Webhook-Secret': 'FAKE-wh' } }, { allowHttp: true }))
      .rejects.toMatchObject({ reason: 'credential_over_plain_http' });
    expect(mockUndiciFetch).not.toHaveBeenCalled();
  });

  it('private / link-local / metadata stay refused by the SSRF rules, even in test env and with allowHttp', async () => {
    setEnv('test');
    await expect(safeFetch('http://10.0.0.5/x', {}, { allowHttp: true })).rejects.toMatchObject({ reason: 'blocked_ip_literal' });
    await expect(safeFetch('https://169.254.169.254/latest/meta-data')).rejects.toMatchObject({ reason: 'blocked_ip_literal' });
    await expect(safeFetch('http://192.168.1.10/x', { headers: { Authorization: 'Bearer x' } }, { allowHttp: true })).rejects.toBeInstanceOf(SsrfBlockedError);
    mockLookup.mockResolvedValueOnce([{ address: '169.254.10.10', family: 4 }]);
    await expect(safeFetch('https://link-local.example/x')).rejects.toMatchObject({ reason: 'resolved_to_blocked_ip' });
    expect(mockUndiciFetch).not.toHaveBeenCalled();
  });

  it('uncredentialed http probing of an external site is unchanged (allowHttp)', async () => {
    setEnv('production');
    mockUndiciFetch.mockResolvedValueOnce(res(200));
    await safeFetch('http://plain.tenant.example/', {}, { allowHttp: true });
    expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
  });
});

// Round 26 / M-1 — a credential in the QUERY STRING is a credentialed request too.
// FAILING CONTROL: at origin/main 2bc52db7a, and at the previous r26-e cut (headers only),
// every refusal case below is fetched over plain http.
describe('M-1: credential-named query parameters over plain http', () => {
  const savedNodeEnv = process.env.NODE_ENV;
  afterEach(() => { (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv; });

  it.each([
    'http://legacy.provider.example/v1/search?api_key=FAKE-q-r26&q=x',
    'http://legacy.provider.example/v1/search?apiKey=FAKE-q-r26',
    'http://pixabay.example/api/?key=FAKE-q-r26&q=cats',
    'http://graph.example/me?access_token=FAKE-q-r26',
    'http://hooks.example/in?signature=FAKE-q-r26',
    'http://legacy.provider.example/x?TOKEN=FAKE-q-r26',
  ])('refused before DNS or any byte: %s', async (u) => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    const err = await safeFetch(u, {}, { allowHttp: true }).catch((e: unknown) => e as SsrfBlockedError);
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect((err as SsrfBlockedError).reason).toBe('credential_over_plain_http');
    expect(String((err as Error).message)).not.toContain('FAKE-q-r26'); // redacted target
    expect(mockUndiciFetch).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('a caller-declared credential query param is refused over http', async () => {
    await expect(safeFetch('http://legacy.provider.example/x?custkey=FAKE-q-r26', {}, { allowHttp: true, credentialQueryParams: ['custkey'] }))
      .rejects.toMatchObject({ reason: 'credential_over_plain_http' });
  });

  it('a credential query param on an http hop REACHED BY REDIRECT is refused too', async () => {
    mockUndiciFetch.mockResolvedValueOnce(res(302, { location: 'http://plain.example/next?api_key=FAKE-q-r26' }));
    await expect(safeFetch('https://api.provider.example/a', {}, { allowHttp: true }))
      .rejects.toMatchObject({ reason: 'credential_over_plain_http' });
    expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
  });

  it('POSITIVE CONTROL: the same credential query over https is allowed', async () => {
    mockUndiciFetch.mockResolvedValueOnce(res(200));
    await safeFetch('https://api.provider.example/v1/search?api_key=FAKE-q-r26', {});
    expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
  });

  it('COMPAT: ordinary http query parameters are not credentials (author, pageToken, q, an empty key)', async () => {
    mockUndiciFetch.mockResolvedValue(res(200));
    await safeFetch('http://wp.tenant.example/wp-json/wp/v2/posts?author=5&per_page=1', {}, { allowHttp: true });
    await safeFetch('http://plain.tenant.example/list?pageToken=abc&q=shoes&key=', {}, { allowHttp: true });
    expect(mockUndiciFetch).toHaveBeenCalledTimes(2);
  });

  it('test-env loopback rule still applies to a credential query (dev allowance unchanged)', async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
    mockUndiciFetch.mockResolvedValueOnce(res(200));
    await safeFetch('http://localhost:3000/x?api_key=FAKE-dev', {}, { allowHttp: true, allowPrivateNetwork: true });
    expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    await expect(safeFetch('http://localhost:3000/x?api_key=FAKE-dev', {}, { allowHttp: true, allowPrivateNetwork: true }))
      .rejects.toMatchObject({ reason: 'loopback_http_not_allowed' });
  });

  it('isCredentialQueryParamName is anchored', () => {
    for (const n of ['api_key', 'apikey', 'API-KEY', 'key', 'access_token', 'token', 'client_secret', 'signature', 'password'])
      expect(isCredentialQueryParamName(n)).toBe(true);
    for (const n of ['author', 'pageToken', 'q', 'keyword', 'monkey', 'tokens_used', 'per_page'])
      expect(isCredentialQueryParamName(n)).toBe(false);
  });
});

describe('helpers', () => {
  it('isCredentialHeaderName covers the required classes and leaves ordinary headers alone', () => {
    for (const n of ['Authorization', 'proxy-authorization', 'Cookie', 'X-Api-Key', 'x-goog-api-key', 'X-Webhook-Secret', 'X-Webhook-Id', 'X-Hub-Signature-256', 'X-Auth-Token', 'X-Shopify-Access-Token']) {
      expect(isCredentialHeaderName(n)).toBe(true);
    }
    for (const n of ['Accept', 'Content-Type', 'User-Agent', 'X-Request-Id']) expect(isCredentialHeaderName(n)).toBe(false);
    expect(isCredentialHeaderName('X-Custom-Cred', ['x-custom-cred'])).toBe(true);
  });
  it('isLoopbackHost', () => {
    expect(['localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1', 'app.localhost'].every(isLoopbackHost)).toBe(true);
    expect(['example.com', '10.0.0.1', 'localhost.example.com', '128.0.0.1'].some(isLoopbackHost)).toBe(false);
  });
});
