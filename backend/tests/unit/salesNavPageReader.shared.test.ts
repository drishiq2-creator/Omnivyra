/**
 * The ONE Sales Navigator page reader - CANONICAL copy (owner ruling 2026-11-21; a9).
 *
 * lib/salesnav/salesNavPageReader.js (+ its one dependency lib/salesnav/profileUrlClass.js) is injected unchanged
 * into the page by the server's Playwright route (89: page.addScriptTag({ content }) then page.evaluate) and is
 * vendored BYTE-IDENTICALLY by the Chrome extension (platforms/linkedin/, pinned by the same sha256 there).
 * Change it HERE, bump READER_VERSION, update both pins, re-vendor; never edit one side alone.
 *
 * This suite: it runs in a page with no extension API; its result carries reader_version; it applies the contract
 * section 4 checks in order (a representative case each); and both files' bytes are pinned.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { JSDOM } from 'jsdom';

const DIR = path.join(__dirname, '..', '..', '..', 'lib', 'salesnav');
const READER = path.join(DIR, 'salesNavPageReader.js');
const PROFILE = path.join(DIR, 'profileUrlClass.js');
const PINS: Record<string, string> = {
  'salesNavPageReader.js': '024fba45a75e1ed8742193027aa079052d27fb68817a6e9b0156419878f25687',
  'profileUrlClass.js': '26341466a9145b18e135bc6bb3681cfc734a9cee127a7029dc9bd5e772b80709',
};
const READER_VERSION = 'snr-1';

const ME = 'urn:li:fsd_profile:ACoAAMEMEMEMEMEMEMEMEMEMEME01';
const meCode = (urn: string) => `<code style="display:none">${JSON.stringify({ data: { $type: 'com.linkedin.voyager.common.Me', dashEntityUrn: urn, plainId: 1 }, included: [] })}</code>`;
const row = (id: string, name: string) => `<tr data-x--people-list--row data-x--lead--urn="urn:li:fs_salesProfile:(${id},NAME_SEARCH,tok)"><td><span data-anonymize="person-name">${name}</span></td></tr>`;
const LIST = 'https://www.linkedin.com/sales/lists/people/70';
const params = (over: Record<string, unknown> = {}) => ({ page_url: LIST, page_index: 0, url_kind: 'lead_list', max_leads: 25, position: { param: 'page', value: '1' }, acting_member_urn: ME, ...over });

/** As Playwright sees it: both files injected as plain scripts; no chrome object. */
function read(url: string, body: string, p: Record<string, unknown>) {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url, runScripts: 'outside-only' });
  const w = dom.window as unknown as { eval: (s: string) => unknown; chrome?: unknown };
  expect(w.chrome).toBeUndefined();
  w.eval(fs.readFileSync(PROFILE, 'utf8'));
  w.eval(fs.readFileSync(READER, 'utf8'));
  return JSON.parse(JSON.stringify(w.eval(`omnivyraSalesNavReader.readSalesNavPage(document, location.href, ${JSON.stringify(p)})`)));
}

const page = (rows: string, nav = '<nav data-x--pagination><button aria-current="true">1</button><button data-x--pagination-next>Next</button></nav>') =>
  `${meCode(ME)}<h1 data-x--list-name>Q4</h1><table><tbody>${rows}</tbody></table>${nav}`;

describe('salesNavPageReader (canonical)', () => {
  it('reads a page with no extension API; every result carries reader_version', () => {
    const r = read(LIST, page(row('ACwAAA01xxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'Ann')), params());
    expect(r).toMatchObject({ ok: true, outcome: 'read', has_next_page: true, reader_version: READER_VERSION });
    expect(r.leads.map((l: { full_name: string }) => l.full_name)).toEqual(['Ann']);
  });

  it.each([
    ['login wall -> auth_expired', 'https://www.linkedin.com/login', '<form data-x--login-form></form>', {}, ['auth_expired', 'LOGIN_OR_CHECKPOINT']],
    ['off-allowlist redirect -> refused', 'https://www.linkedin.com/feed/', page(row('ACwAAA01xxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'Ann')), {}, ['refused', 'OFF_ALLOWLIST_REDIRECT']],
    ['rate notice -> rate_limited', LIST, `${page(row('ACwAAA01xxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'Ann'))}<div data-x--rate-limit-notice></div>`, {}, ['rate_limited', 'LINKEDIN_RATE_NOTICE']],
    ['another member -> refused', LIST, page(row('ACwAAA01xxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'Ann')).replace(ME, 'urn:li:fsd_profile:ACoAAOTHEROTHEROTHEROTHER0001'), {}, ['refused', 'MEMBER_MISMATCH']],
    ['page 1 served for page 2 -> unknown', LIST, page(row('ACwAAA01xxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'Ann')), { page_url: `${LIST}?page=2`, page_index: 1, position: { param: 'page', value: '2' } }, ['unknown', 'PAGE_POSITION_MISMATCH']],
    ['no rows, no empty state -> unknown', LIST, `${meCode(ME)}<div>loading</div>`, {}, ['unknown', 'PAGE_NOT_RECOGNISED']],
  ])('%s, nothing read', (_n, url, body, over, [outcome, code]) => {
    const r = read(url as string, body as string, params(over as Record<string, unknown>));
    expect([r.outcome, r.outcome_code, r.leads.length, r.reader_version]).toEqual([outcome, code, 0, READER_VERSION]);
  });

  it('a command without a valid position rule fails closed (POSITION_RULE_MISSING)', () => {
    const r = read(LIST, page(row('ACwAAA01xxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'Ann')), params({ position: undefined }));
    expect([r.ok, r.code]).toEqual([false, 'POSITION_RULE_MISSING']);
  });

  it('PIN: both files byte-identical to the vendored extension copies (sha256), and READER_VERSION', () => {
    for (const [name, sha] of Object.entries(PINS)) {
      expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, name))).digest('hex')).toBe(sha);
    }
    expect(fs.readFileSync(READER, 'utf8')).toContain(`const READER_VERSION = '${READER_VERSION}';`);
  });
});
