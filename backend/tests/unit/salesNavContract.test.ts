/** Sales Navigator shared contract v1.1 - the pure parts every route depends on (c6). */
import {
  parseSalesNavUrl, pageUrlFor, canonicalMemberId, isAllowedClose, isRepeatedPage, pageReservationRequest, isCommandedPage,
  SALESNAV_STATUS_CODES, SALESNAV_TERMINAL_STATUSES, SALESNAV_RUN_STATUSES, SALESNAV_TRANSPORTS, SALESNAV_SOURCE,
  MAX_SALESNAV_PAGE, DEFAULT_SALESNAV_DAILY_CAP, MAX_SALESNAV_DAILY_CAP, resolveDailyCap, parseListTotal,
  isAllowedPause, SALESNAV_RESUMABLE_STATUSES,
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

describe('pageUrlFor - page URLs AND position rules are built here and nowhere else (v2.1)', () => {
  const base = 'https://www.linkedin.com/sales/search/people?query=x';
  it('page 0 is the canonical URL with position 1; page n sets page=n+1', () => {
    expect(pageUrlFor(base, 0)).toEqual({ pageUrl: base, position: { param: 'page', value: '1' } });
    expect(pageUrlFor(base, 1)).toEqual({ pageUrl: `${base}&page=2`, position: { param: 'page', value: '2' } });
    expect(pageUrlFor('https://www.linkedin.com/sales/lists/people/70', 3))
      .toEqual({ pageUrl: 'https://www.linkedin.com/sales/lists/people/70?page=4', position: { param: 'page', value: '4' } });
  });
  it('re-validates: a non-allowed URL or a bad index yields null (never a URL)', () => {
    expect(pageUrlFor('https://evil.example/sales/search/people', 1)).toBeNull();
    for (const i of [-1, 1.5, Number.NaN, 1000]) expect(pageUrlFor(base, i)).toBeNull();
  });
  it('an incoming page parameter cannot survive into a different page', () => {
    expect(pageUrlFor(`${base}&page=9`, 1)!.pageUrl).toBe(`${base}&page=2`);
  });
});

describe('isCommandedPage - the one position check for the browser routes', () => {
  const base = 'https://www.linkedin.com/sales/search/people?query=x';
  const p2 = pageUrlFor(base, 1)!;
  const p0 = pageUrlFor(base, 0)!;
  it('control: the commanded page is recognised (and page 1 with no parameter)', () => {
    expect(isCommandedPage(p2.pageUrl, p2.pageUrl, p2.position)).toBe(true);
    expect(isCommandedPage(base, p0.pageUrl, p0.position)).toBe(true);
  });
  it('LinkedIn served page 1 for page 2 (parameter dropped on redirect) -> false', () => {
    expect(isCommandedPage(base, p2.pageUrl, p2.position)).toBe(false);
  });
  it('a different page number -> false', () => {
    expect(isCommandedPage(`${base}&page=3`, p2.pageUrl, p2.position)).toBe(false);
  });
  it('a different search or list, or off the allowlist -> false', () => {
    expect(isCommandedPage('https://www.linkedin.com/sales/search/people?query=y&page=2', p2.pageUrl, p2.position)).toBe(false);
    expect(isCommandedPage('https://www.linkedin.com/feed/?page=2', p2.pageUrl, p2.position)).toBe(false);
    expect(isCommandedPage('https://www.linkedin.com/checkpoint/challenge', p2.pageUrl, p2.position)).toBe(false);
  });
  it('a malformed position rule or URL is false, never a throw', () => {
    expect(isCommandedPage(p2.pageUrl, p2.pageUrl, { param: 'page', value: 'two' } as never)).toBe(false);
    expect(isCommandedPage(p2.pageUrl, p2.pageUrl, null as never)).toBe(false);
    expect(isCommandedPage(42, p2.pageUrl, p2.position)).toBe(false);
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
    const nonTerminal = ['queued', 'running', ...SALESNAV_RESUMABLE_STATUSES] as string[];
    expect([...SALESNAV_TERMINAL_STATUSES].sort()).toEqual(
      SALESNAV_RUN_STATUSES.filter((s) => !nonTerminal.includes(s)).slice().sort());
    for (const s of SALESNAV_TERMINAL_STATUSES) expect((SALESNAV_STATUS_CODES as Record<string, string[]>)[s].length).toBeGreaterThan(0);
  });
  it('isAllowedClose accepts only listed (status, code) pairs', () => {
    expect(isAllowedClose('auth_expired', 'checkpoint')).toBe(false);   // v2: a RESUMABLE state, not a close
    expect(isAllowedPause('auth_expired', 'checkpoint')).toBe(true);
    expect(isAllowedPause('paused_daily_cap', 'daily_cap')).toBe(true);
    expect(isAllowedPause('paused_daily_cap', 'checkpoint')).toBe(false);
    expect(isAllowedPause('completed', 'no_next_page')).toBe(false);
    expect(isAllowedClose('partial_capped', 'daily_cap')).toBe(false);  // v2: replaced by paused_daily_cap
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
    expect(DEFAULT_SALESNAV_DAILY_CAP).toBe(150);
    expect(MAX_SALESNAV_DAILY_CAP).toBe(200);
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

describe('resolveDailyCap (owner 2026-11-21: default 150, hard max 200)', () => {
  it('honours an integer 1..200', () => {
    for (const v of [1, 150, 175, 200]) expect(resolveDailyCap(v)).toBe(v);
    expect(resolveDailyCap(' 180 ')).toBe(180);
  });
  it('anything else falls back to the DEFAULT (never more reading)', () => {
    for (const v of [undefined, null, 0, -5, 201, 500, 150.5, Number.NaN, '1,000', 'abc', {}, '']) expect(resolveDailyCap(v)).toBe(150);
  });
});

describe('parseListTotal - exact integers only (a9 r6)', () => {
  it('accepts exact counts', () => {
    expect(parseListTotal(312)).toBe(312);
    expect(parseListTotal('312')).toBe(312);
    expect(parseListTotal(0)).toBe(0);
  });
  it.each(['1,000+', '1K', '2.5K', 'about 300', '1,234', '12.0', -3, 2.5, null, undefined, NaN, '', ' '])('%p -> null', (v) => {
    expect(parseListTotal(v)).toBeNull();
  });
});

describe('pageReservationRequest (v2: A / B / the page beats the total)', () => {
  const base = { pageIndex: 1, listTotal: 100 as unknown, readSoFar: 25, lastHasNextPage: true as boolean | null, totalUnreliable: false };
  it('A: page 0 is always 25, disclosed', () => {
    expect(pageReservationRequest({ ...base, pageIndex: 0 })).toEqual({ requested: 25, disclosed: true, totalUnreliable: false });
  });
  it('A: an unknown or non-exact total is 25, disclosed', () => {
    for (const t of [null, '1,000+', '2.5K']) expect(pageReservationRequest({ ...base, listTotal: t })).toEqual({ requested: 25, disclosed: true, totalUnreliable: false });
  });
  it('B: min(25, total - read)', () => {
    expect(pageReservationRequest(base)).toEqual({ requested: 25, disclosed: false, totalUnreliable: false });
    expect(pageReservationRequest({ ...base, readSoFar: 90 })).toEqual({ requested: 10, disclosed: false, totalUnreliable: false });
  });
  it('THE PAGE BEATS THE TOTAL: B computes 0 but the page says there is more -> A + totalUnreliable', () => {
    expect(pageReservationRequest({ ...base, readSoFar: 100, lastHasNextPage: true })).toEqual({ requested: 25, disclosed: true, totalUnreliable: true });
  });
  it('control: B computes 0 and there is NO next page -> request 0 (the run completes; NOT a cap)', () => {
    expect(pageReservationRequest({ ...base, readSoFar: 100, lastHasNextPage: false })).toEqual({ requested: 0, disclosed: false, totalUnreliable: false });
  });
  it('once unreliable, stays on A for the rest of the run', () => {
    expect(pageReservationRequest({ ...base, readSoFar: 10, totalUnreliable: true })).toEqual({ requested: 25, disclosed: true, totalUnreliable: true });
  });
});
