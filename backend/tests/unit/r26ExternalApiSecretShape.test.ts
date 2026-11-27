/**
 * Round 26 (Agent B) — the H-2 secret-shape rule for `headers` / `query_params` values, and the
 * diagnostic-message redaction used by test-connection.
 *
 * The rule must catch what the Super Admin UI invited (a key pasted under a credential-named
 * key, `_client_secret_env`, a raw provider key under any name) WITHOUT flagging ordinary
 * parameters, or every catalog edit would start failing. Both directions are pinned here.
 * FAKE fixtures only.
 */
import {
  findNewSecretShapedEntries,
  isSecretShapedMapValue,
  redactDiagnosticMessage,
  redactSecretShapedMap,
  restoreRedactedMapValues,
  REDACTED_SECRET_VALUE,
} from '../../services/externalApi/credentialReference';

const FAKE_HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // fake

describe('isSecretShapedMapValue — flagged', () => {
  it.each([
    ['X-Api-Key', FAKE_HEX],
    ['Authorization', ['Bearer', FAKE_HEX].join(' ')],
    ['Authorization', 'Basic dXNlcjpwYXNz'],
    ['api_key', 'shortkey1'],
    ['key', 'AIzaFakeFixture000000000000000000000000'],
    ['_client_secret_env', 'fake_client_secret_fixture_0123456789'],
    ['_client_id_env', 'fakeClientIdFixture'],
    ['token', 'abc'],
    ['q', FAKE_HEX], // raw 32-hex under an innocuous name
    ['x', 'sk-fakefixture000000'],
    ['x', 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo'], // 43-char token, letters + digits
    ['Authorization', ['Bearer {{NEWS_API_KEY}}', FAKE_HEX].join(' ')], // a template does not launder a literal
  ])('%s = <fixture>', (k, v) => {
    expect(isSecretShapedMapValue(k, v)).toBe(true);
  });
});

describe('isSecretShapedMapValue — NOT flagged (false-positive guard)', () => {
  it.each([
    ['Authorization', 'Bearer {{NEWS_API_KEY}}'],
    ['apiKey', '{{NEWS_API_KEY}}'],
    ['api_key', 'SERPAPI_KEY'], // an env-var NAME, not a value
    ['_client_secret_env', 'UNSPLASH_SECRET_KEY'],
    ['Accept', 'application/json'],
    ['User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'],
    ['country', 'us'],
    ['sources', 'bbc-news,cnn,reuters'],
    ['channelId', 'UC_x5XG1OV2P6uZZ5FSM9Ttw'], // 24-char id
    ['since', '2026-11-26T00:00:00Z'],
    ['callback', 'https://example.com/hook?x=1'],
    ['id', '550e8400-e29b-41d4-a716-446655440000'], // a UUID (36, has hyphens, mixed) — see note
    ['limit', 50 as unknown as string],
    ['x', REDACTED_SECRET_VALUE],
  ])('%s = %s', (k, v) => {
    expect(isSecretShapedMapValue(k, v)).toBe(false);
  });
});

describe('map helpers', () => {
  it('redactSecretShapedMap replaces only the secret entries and never mutates', () => {
    const input = { Accept: 'application/json', 'X-Api-Key': FAKE_HEX };
    const out = redactSecretShapedMap(input);
    expect(out).toEqual({ Accept: 'application/json', 'X-Api-Key': REDACTED_SECRET_VALUE });
    expect(input['X-Api-Key']).toBe(FAKE_HEX);
  });

  it('restoreRedactedMapValues puts the stored value back for a marker, drops an unknown marker', () => {
    expect(restoreRedactedMapValues(
      { 'X-Api-Key': REDACTED_SECRET_VALUE, Other: REDACTED_SECRET_VALUE, Accept: 'text/csv' },
      { 'X-Api-Key': FAKE_HEX },
    )).toEqual({ 'X-Api-Key': FAKE_HEX, Accept: 'text/csv' });
  });

  it('findNewSecretShapedEntries: an unchanged legacy value passes, a new one is named (never echoed)', () => {
    expect(findNewSecretShapedEntries({ 'X-Api-Key': FAKE_HEX }, { 'X-Api-Key': FAKE_HEX })).toEqual([]);
    const bad = findNewSecretShapedEntries({ 'X-Api-Key': FAKE_HEX, [FAKE_HEX]: FAKE_HEX }, {});
    expect(bad).toEqual(['X-Api-Key', '<unnamed>']);
    expect(JSON.stringify(bad)).not.toContain(FAKE_HEX);
  });
});

describe('redactDiagnosticMessage', () => {
  it('cuts out the sent credential verbatim, then the generic URL/name=value redaction', () => {
    const msg = `Your API key ${FAKE_HEX} is invalid (GET https://newsapi.org/v2/top-headlines?apiKey=${FAKE_HEX})`;
    const out = redactDiagnosticMessage(msg, [FAKE_HEX]);
    expect(out).not.toContain(FAKE_HEX);
    expect(out).toContain('is invalid');
  });
  it('generic redaction still applies when the secret is not known', () => {
    expect(redactDiagnosticMessage(`token=${FAKE_HEX}`)).not.toContain(FAKE_HEX);
  });
  it('bounds the length', () => {
    expect(redactDiagnosticMessage('x'.repeat(1000)).length).toBeLessThanOrEqual(301);
  });
});
