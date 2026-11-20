/** Sales Navigator shared contract v1.1 - the pure parts every route depends on (c6). */
import {
  parseSalesNavUrl, pageUrlFor, canonicalMemberId, isAllowedClose, isRepeatedPage, pageReservationRequest,
  SALESNAV_STATUS_CODES, SALESNAV_TERMINAL_STATUSES, SALESNAV_RUN_STATUSES, SALESNAV_TRANSPORTS, SALESNAV_SOURCE,
  MAX_SALESNAV_PAGE, DEFAULT_SALESNAV_DAILY_CAP,
} from '../../services/salesNav/contract';

describe('parseSalesNavUrl - the one allowlist', () => {
  it.each([
    ['https://www.linkedin.com/sales/search/people?query=(keywords%3ACTO)', 'people_search', 'https://www.linkedin.com/sales/search/people?query=%28keywords%3ACTO%29'],
    ['https://linkedin.com/sales/search/people/?query=x', 'people_search', 'https://www.linkedin.com/sales/search/people?query=x'],
    ['https://www.linkedin.com/sales/search/people?savedSearchId=123', 'saved_search', 'https://www.linkedin.com/sales/search/people?savedSearchId=123'],
    ['https://www.linkedin.com/sales/lists/people/7012345678?sortCriteria=CREATED_TIME', 'lead_list', 'https://www.linkedin.com/sales/lists/people/7012345678?sortCriteria=CREATED_TIME'],
  ])('ALLOWS %s as %s', (url, kind, canonical) => {
    expect(parseSalesNavUrl(url)).toEqual({ ok: true, kind, canonicalUrl: canonical });
  });

  it.each([
    [42, 'not_a_url'], ['not a url', 'not_a_url'], ['x'.repeat(4001), 'not_a_url'],
    ['http://www.linkedin.com/sales/search/people', 'not_https'],
    ['https://www.linkedin.com.evil.example/sales/search/people', 'not_linkedin'],
    ['https://evil.example/sales/search/people', 'not_linkedin'],
    ['https://www.linkedin.com:8443/sales/search/people', 'not_linkedin'],
    ['https://u:p@www.linkedin.com/sales/search/people', 'not_linkedin'],
    ['https://www.linkedin.com/in/ada', 'not_sales_navigator'],
    ['https://www.linkedin.com/sales/lists/company/123', 'unsupported_kind'],
    ['https://www.linkedin.com/sales/search/company?query=x', 'unsupported_kind'],
    ['https://www.linkedin.com/sales/lead/ACwAA1', 'unsupported_kind'],
    ['https://www.linkedin.com/sales/lists/people/../../in/x', 'unsupported_kind'],   // normalised to /sales/in/x: still refused
  ])('REFUSES %s (%s)', (url, refused) => {
    expect(parseSalesNavUrl(url)).toEqual({ ok: false, refused });
  });

  it('a caller-supplied page parameter is dropped from the canonical URL (paging is ours)', () => {
    expect(parseSalesNavUrl('https://www.linkedin.com/sales/search/people?query=x&page=7'))
      .toEqual({ ok: true, kind: 'people_search', canonicalUrl: 'https://www.linkedin.com/sales/search/people?query=x' });
  });
});

describe('pageUrlFor - page URLs are built here and nowhere else', () => {
  const base = 'https://www.linkedin.com/sales/search/people?query=x';
  it('page 0 is the canonical URL; page n sets page=n+1', () => {
    expect(pageUrlFor(base, 0)).toBe(base);
    expect(pageUrlFor(base, 1)).toBe(`${base}&page=2`);
    expect(pageUrlFor('https://www.linkedin.com/sales/lists/people/70', 3)).toBe('https://www.linkedin.com/sales/lists/people/70?page=4');
  });
  it('re-validates: a non-allowed URL or a bad index yields null (never a URL)', () => {
    expect(pageUrlFor('https://evil.example/sales/search/people', 1)).toBeNull();
    for (const i of [-1, 1.5, Number.NaN, 1000]) expect(pageUrlFor(base, i)).toBeNull();
  });
  it('an incoming page parameter cannot survive into a different page', () => {
    expect(pageUrlFor(`${base}&page=9`, 1)).toBe(`${base}&page=2`);
  });
});

describe('canonicalMemberId - the shared cap key', () => {
  const ID = 'ACoAAA1b2C3d4E5f6G7h';
  it.each([ID, `urn:li:fsd_profile:${ID}`, `urn:li:fs_miniProfile:${ID}`, `  ${ID}  `])('%s -> the bare id', (raw) => {
    expect(canonicalMemberId(raw)).toBe(ID);
  });
  it.each([null, 42, '', 'ACwAA1', 'urn:li:member:123', 'urn:li:fsd_profile:', `urn:li:fsd_salesProfile:(${ID},x,y)`, 'ACoAA short'])(
    '%p -> null (and a null member can never reserve quota)', (raw) => {
      expect(canonicalMemberId(raw)).toBeNull();
    });
});

describe('the job model', () => {
  it('every terminal status has a closed code set; non-terminal states have none', () => {
    expect([...SALESNAV_TERMINAL_STATUSES].sort()).toEqual(
      SALESNAV_RUN_STATUSES.filter((s) => s !== 'queued' && s !== 'running').slice().sort());
    for (const s of SALESNAV_TERMINAL_STATUSES) expect((SALESNAV_STATUS_CODES as Record<string, string[]>)[s].length).toBeGreaterThan(0);
  });
  it('isAllowedClose accepts only listed (status, code) pairs', () => {
    expect(isAllowedClose('auth_expired', 'checkpoint')).toBe(true);
    expect(isAllowedClose('completed', 'empty_first_page')).toBe(true);
    expect(isAllowedClose('completed', 'checkpoint')).toBe(false);      // a code from another status
    expect(isAllowedClose('running', 'no_next_page')).toBe(false);      // not terminal
    expect(isAllowedClose('done', 'no_next_page')).toBe(false);         // not a status
    expect(isAllowedClose('unknown', undefined)).toBe(false);           // a close always names its code
  });
  it('v1.2: cancelled is terminal with user_cancelled; the three new unknown codes exist; refused lost stopped_by_user', () => {
    expect(isAllowedClose('cancelled', 'user_cancelled')).toBe(true);
    for (const c of ['page_position_mismatch', 'page_repeated', 'run_stale', 'response_lost']) expect(isAllowedClose('unknown', c)).toBe(true);
    expect(isAllowedClose('refused', 'stopped_by_user')).toBe(false);
    expect(SALESNAV_TERMINAL_STATUSES).toContain('cancelled');
  });
  it('constants', () => {
    expect(SALESNAV_SOURCE).toBe('linkedin_sales_navigator');
    expect(SALESNAV_TRANSPORTS).toEqual(['extension', 'unipile', 'vayne', 'rpa']);
    expect(MAX_SALESNAV_PAGE).toBe(25);
    expect(DEFAULT_SALESNAV_DAILY_CAP).toBe(500);
  });
});

describe('isRepeatedPage - the set-overlap backstop (v1.3)', () => {
  const k = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `k${i + from}`);
  it('the same keys in a DIFFERENT ORDER are a repeat (lists reorder)', () => {
    expect(isRepeatedPage(k(25), [...k(25)].reverse())).toBe(true);
  });
  it('boundary: 80% of this page AND >= 3 keys', () => {
    expect(isRepeatedPage(k(10), [...k(4), ...k(1, 100)])).toBe(true);         // 4/5 = 80%, 4 >= 3
    expect(isRepeatedPage(k(10), [...k(3), ...k(1, 100)])).toBe(false);        // 3/4 = 75% < 80%
    expect(isRepeatedPage(k(10), k(2))).toBe(false);                            // 100% but only 2 keys
    expect(isRepeatedPage(k(10), k(3))).toBe(true);                             // 3 keys, 100%
  });
  it('a genuinely new page, a first page, and an empty page are never repeats', () => {
    expect(isRepeatedPage(k(25), k(25, 25))).toBe(false);
    expect(isRepeatedPage([], k(25))).toBe(false);
    expect(isRepeatedPage(k(25), [])).toBe(false);
  });
  it('duplicate keys within a page do not inflate the overlap', () => {
    expect(isRepeatedPage(['a', 'b'], ['a', 'a', 'a', 'b', 'b'])).toBe(false);   // 2 distinct only
  });
});

describe('pageReservationRequest - the reservation rule', () => {
  it('known remaining -> min(25, remaining), not disclosed', () => {
    expect(pageReservationRequest(100)).toEqual({ requested: 25, disclosed: false });
    expect(pageReservationRequest(7)).toEqual({ requested: 7, disclosed: false });
    expect(pageReservationRequest(0)).toEqual({ requested: 0, disclosed: false });
    expect(pageReservationRequest(7.9)).toEqual({ requested: 7, disclosed: false });
  });
  it('unknown remaining -> 25 WITH disclosure (never silently assumed)', () => {
    for (const v of [null, undefined, Number.NaN, -1, Infinity]) expect(pageReservationRequest(v as never)).toEqual({ requested: 25, disclosed: true });
  });
});
