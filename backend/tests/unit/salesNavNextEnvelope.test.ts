/**
 * The signed /next answer: the pinned vectors (shared byte-for-byte with the extension's parity test), the verbatim
 * canonical() copy against the stranded-line envelopeVectors.json `canonical_basic` vector, and the controls that make
 * the signature mean something (another domain, another field, another secret -> a different signature).
 */
import { createHmac } from 'crypto';
import vectors from '../fixtures/salesNavNextVectors.json';
import {
  canonical, SALESNAV_NEXT_DOMAIN, signNextEnvelope, verifyNextEnvelope, type SalesNavNextEnvelope,
} from '../../services/salesNav/nextEnvelope';

const env = vectors.envelope as SalesNavNextEnvelope;

describe('canonical() - the verbatim copy of lib/extension/envelope.ts:42', () => {
  it('matches the stranded-line envelopeVectors.json canonical_basic vector', () => {
    expect(canonical(vectors.canonical_basic.input)).toBe(vectors.canonical_basic.expected);
    expect(vectors.canonical_basic.expected).toBe('{"a":1,"b":[true,null,"x"]}');
  });
  it('omits undefined-valued keys, sorts keys, and refuses a non-finite number', () => {
    expect(canonical({ z: 1, a: undefined, m: 'x' })).toBe('{"m":"x","z":1}');
    expect(() => canonical({ n: Number.NaN })).toThrow('non-finite');
  });
});

// The THROW vectors both sides pin (a9 parity test mirrors each case by name). JSON cannot carry undefined or a
// function, so the cases are constructed in code; the fixture lists their names in `canonical_throws`.
describe('canonical(): inputs BOTH sides refuse (no side picks a rendering)', () => {
  const sparse = [1, 2]; delete (sparse as unknown[])[0];
  const cases: Array<[string, unknown]> = [
    ['undefined_array_element', [1, undefined]],
    ['sparse_array_hole', sparse],
    ['nested_undefined_array_element', { a: [true, undefined] }],
    ['function_value', { f: () => 1 }],
    ['symbol_value', { s: Symbol('x') }],
    ['bigint_value', { b: BigInt(1) }],
    ['date_object', { d: new Date(0) }],
    ['map_object', { m: new Map() }],
    ['top_level_undefined', undefined],
  ];
  it.each(cases)('%s throws', (_name, input) => {
    expect(() => canonical(input)).toThrow();
  });
  it('the fixture names exactly these cases (the extension mirrors the same list)', () => {
    expect([...vectors.canonical_throws].sort()).toEqual(cases.map(([n]) => n).sort());
  });
  it('control: every accepted type still renders - including a null-prototype object and a null array element', () => {
    const bare = Object.create(null) as Record<string, unknown>; bare.k = 'v';
    expect(canonical({ a: [null, true, 0, 'x', { y: [] }], bare })).toBe('{"a":[null,true,0,"x",{"y":[]}],"bare":{"k":"v"}}');
  });
});

describe('the pinned /next vector', () => {
  it('the domain is omnivyra.salesnav.next.v1', () => {
    expect(vectors.domain).toBe(SALESNAV_NEXT_DOMAIN);
  });
  it('canonical(envelope) and the signature reproduce exactly', () => {
    expect(canonical(env)).toBe(vectors.canonical);
    expect(signNextEnvelope(env, vectors.secret)).toBe(vectors.signature);
    expect(verifyNextEnvelope(env, vectors.signature, vectors.secret)).toBe(true);
  });
  it('CONTROL: the v15 COMMAND domain over the same bytes is a different signature (no cross-replay)', () => {
    const v15 = createHmac('sha256', vectors.secret).update(`omnivyra.ext.cmd.v1\n${vectors.canonical}`).digest('hex');
    expect(v15).not.toBe(vectors.signature);
    expect(verifyNextEnvelope(env, v15, vectors.secret)).toBe(false);
  });
  it.each([
    ['another page_index', { page_index: 2 }],
    ['another page_url', { page_url: 'https://www.linkedin.com/sales/lists/people/999?page=2' }],
    ['more leads', { max_leads: 26 }],
    ['another member', { member: 'urn:li:fsd_profile:ACoAAAvectorTest0002' }],
    ['a later expiry', { expires_at: '2026-11-21T12:05:00.000Z' }],
  ])('CONTROL: %s does not verify against the pinned signature', (_l, change) => {
    expect(verifyNextEnvelope({ ...env, ...change } as SalesNavNextEnvelope, vectors.signature, vectors.secret)).toBe(false);
  });
  it('CONTROL: another secret does not verify; a malformed signature is refused', () => {
    expect(verifyNextEnvelope(env, vectors.signature, 'another-test-secret')).toBe(false);
    expect(verifyNextEnvelope(env, 'not-hex', vectors.secret)).toBe(false);
  });
});
