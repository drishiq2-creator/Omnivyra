/**
 * P2-C — registrableRoot on the vendored, dated Public Suffix List.
 *
 * The registrable domain is the company identity key (one company per
 * registrable domain; CLAIMED_DOMAIN). The pre-PSL implementation knew 25
 * multi-part suffixes, so `acme.com.sg` collapsed to `com.sg` and the first
 * Singapore customer claimed the whole suffix. These tests lock the PSL result
 * AND the edge cases the old function already had.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  registrableRoot,
  normalizeCompanyDomain,
  isSameCompanyDomain,
} from '../../../lib/shared/domain/companyDomain';
import { isPublicSuffix, publicSuffixLabelCount } from '../../../lib/shared/domain/publicSuffix';
import {
  PUBLIC_SUFFIX_LIST_META,
  PUBLIC_SUFFIX_RULES,
} from '../../../lib/shared/domain/publicSuffixRules.generated';

const DOMAIN_DIR = path.join(__dirname, '..', '..', '..', 'lib', 'shared', 'domain');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const generator = require('../../../scripts/generate-public-suffix-rules.js');

describe('registrableRoot — suffixes the old 25-entry list collapsed', () => {
  it.each([
    ['acme.com.sg', 'acme.com.sg'],
    ['mail.acme.co.il', 'acme.co.il'],
    ['x.acme.com.tr', 'acme.com.tr'],
    ['www.acme.co.th', 'acme.co.th'],
    ['a.acme.com.hk', 'acme.com.hk'],
    ['a.acme.com.tw', 'acme.com.tw'],
    ['a.acme.com.my', 'acme.com.my'],
    ['a.acme.com.ph', 'acme.com.ph'],
    ['a.acme.com.vn', 'acme.com.vn'],
    ['a.acme.com.ua', 'acme.com.ua'],
    ['a.acme.com.ng', 'acme.com.ng'],
  ])('%s -> %s', (host, root) => {
    expect(registrableRoot(host)).toBe(root);
  });

  it('two companies on com.sg get two distinct identity keys', () => {
    expect(normalizeCompanyDomain('jane@acme.com.sg')).toBe('acme.com.sg');
    expect(normalizeCompanyDomain('https://www.globex.com.sg/about')).toBe('globex.com.sg');
    expect(isSameCompanyDomain('jane@acme.com.sg', 'bob@globex.com.sg')).toBe(false);
  });
});

describe('registrableRoot — behaviour the old list already got right is kept', () => {
  it.each([
    ['shop.acme.co.uk', 'acme.co.uk'],
    ['bot1.example.com', 'example.com'],
    ['bot2.example.com', 'example.com'],
    ['a.b.c.example.com', 'example.com'],
    ['mail.acme.com.au', 'acme.com.au'],
    ['mail.acme.co.in', 'acme.co.in'],
    ['x.acme.co.jp', 'acme.co.jp'],
  ])('%s -> %s', (host, root) => {
    expect(registrableRoot(host)).toBe(root);
  });

  it('subdomains of one company share a key', () => {
    expect(isSameCompanyDomain('bot1.example.com', 'bot2.example.com')).toBe(true);
  });
});

describe('registrableRoot — PSL rule kinds from the real list', () => {
  it('PRIVATE section applies: foo.github.io is its own registrable domain', () => {
    expect(registrableRoot('foo.github.io')).toBe('foo.github.io');
    expect(registrableRoot('www.foo.github.io')).toBe('foo.github.io');
    expect(isSameCompanyDomain('foo.github.io', 'bar.github.io')).toBe(false);
  });

  it('wildcard rule *.ck: one extra label is part of the suffix', () => {
    expect(PUBLIC_SUFFIX_RULES.split(' ')).toContain('*.ck');
    expect(registrableRoot('shop.acme.co.ck')).toBe('acme.co.ck');
  });

  it('exception rule !www.ck: www.ck is registrable despite *.ck', () => {
    expect(PUBLIC_SUFFIX_RULES.split(' ')).toContain('!www.ck');
    expect(registrableRoot('a.www.ck')).toBe('www.ck');
  });

  it('deeper wildcard + exception pair: *.kawasaki.jp / !city.kawasaki.jp', () => {
    expect(registrableRoot('a.b.foo.kawasaki.jp')).toBe('b.foo.kawasaki.jp');
    expect(registrableRoot('a.city.kawasaki.jp')).toBe('city.kawasaki.jp');
  });

  it('IDN rule matches in both Unicode and punycode form', () => {
    // 個人.香港 is an ICANN rule under .hk; xn--gmqw5a.xn--j6w193g is its ASCII form.
    expect(registrableRoot('www.acme.個人.香港')).toBe('acme.個人.香港');
    expect(registrableRoot('www.acme.xn--gmqw5a.xn--j6w193g')).toBe('acme.xn--gmqw5a.xn--j6w193g');
  });

  it('unlisted TLD falls back to the default rule (last label)', () => {
    expect(publicSuffixLabelCount(['a', 'b', 'notarealtld'])).toBe(1);
    expect(registrableRoot('a.b.notarealtld')).toBe('b.notarealtld');
  });
});

describe('registrableRoot — edge cases identical to the pre-PSL function', () => {
  it('empty input returns empty', () => {
    expect(registrableRoot('')).toBe('');
  });

  it('one or two labels are returned exactly as given (bare suffix stays itself)', () => {
    expect(registrableRoot('localhost')).toBe('localhost');
    expect(registrableRoot('com')).toBe('com');
    expect(registrableRoot('com.sg')).toBe('com.sg');
    expect(registrableRoot('co.uk')).toBe('co.uk');
    expect(registrableRoot('acme.com')).toBe('acme.com');
  });

  it('a 3+ label host that is itself a public suffix is not collapsed', () => {
    expect(isPublicSuffix('foo.kawasaki.jp')).toBe(true);
    expect(registrableRoot('foo.kawasaki.jp')).toBe('foo.kawasaki.jp');
  });

  it('IPv4 literals keep the old last-two-labels result', () => {
    expect(registrableRoot('192.168.1.10')).toBe('1.10');
    expect(registrableRoot('10.0.0.1')).toBe('0.1');
  });

  it('normalizeCompanyDomain edge cases unchanged', () => {
    expect(normalizeCompanyDomain('')).toBe('');
    expect(normalizeCompanyDomain(null)).toBe('');
    expect(normalizeCompanyDomain('localhost')).toBe('');
    expect(normalizeCompanyDomain('http://localhost:3000/x')).toBe('');
    expect(normalizeCompanyDomain('john@mail.acme.com')).toBe('acme.com');
  });

  // 7c 2026-11-19 replaces "KNOWN_MULTI_PART_TLDS stays exported for its remaining importer": the hand list is
  // DELETED - one source for "is this a public suffix" (the PSL). accountSeeding asks isPublicSuffix.
  it('the legacy hand list is gone and accountSeeding asks the PSL (one source for "is a public suffix")', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/shared/domain/companyDomain.ts'), 'utf8');
    expect(src).not.toMatch(/KNOWN_MULTI_PART_TLDS/);
    const seeding = fs.readFileSync(path.join(process.cwd(), 'backend/services/prospectIdentity/accountSeeding.ts'), 'utf8');
    expect(seeding).toMatch(/if \(isPublicSuffix\(domain\)\)/);
    for (const s of ['co.uk', 'com.sg', 'myshopify.com', 'github.io']) expect([s, isPublicSuffix(s)]).toEqual([s, true]);
  });
});

describe('vendored PSL snapshot carries its dated provenance', () => {
  const datBuf = fs.readFileSync(path.join(DOMAIN_DIR, 'publicSuffixList.dat'));
  const meta = JSON.parse(fs.readFileSync(path.join(DOMAIN_DIR, 'publicSuffixList.meta.json'), 'utf8'));

  it('meta records source URL and an ISO retrieval date', () => {
    expect(meta.source).toBe('https://publicsuffix.org/list/public_suffix_list.dat');
    expect(meta.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the .dat is the unmodified upstream text recorded in meta', () => {
    expect(datBuf.length).toBe(meta.bytes);
    expect(crypto.createHash('sha256').update(datBuf).digest('hex')).toBe(meta.sha256);
    const text = datBuf.toString('utf8');
    expect(text.startsWith('// This Source Code Form is subject to the terms of the Mozilla Public')).toBe(true);
    expect(text).toContain('// ===BEGIN ICANN DOMAINS===');
    expect(text).toContain('// ===BEGIN PRIVATE DOMAINS===');
    expect(text).toContain(`// VERSION: ${meta.upstreamVersion}`);
  });

  it('the generated module is in sync with the .dat + meta (regenerate to fix)', () => {
    const generated = fs.readFileSync(path.join(DOMAIN_DIR, 'publicSuffixRules.generated.ts'), 'utf8');
    expect(generated).toBe(generator.buildRulesModule(datBuf, meta));
    expect(generated).toContain(`// Retrieved:        ${meta.retrievedAt}`);
    expect(PUBLIC_SUFFIX_LIST_META.retrievedAt).toBe(meta.retrievedAt);
    expect(PUBLIC_SUFFIX_LIST_META.sha256).toBe(meta.sha256);
  });
});

// c6/89 2026-11-19: the owner's rule - ONE company per REGISTRABLE domain, and the website's registrable domain must equal
// the admin email's - is enforced by the onboarding binding through isSameCompanyDomain ONLY, so these pin what it will
// decide. Each case is one the pre-PSL helper got WRONG (control: it fails on main's companyDomain.ts).
describe('owner rule (onboarding binding): one company per registrable domain', () => {
  it('two Shopify shops are two companies (myshopify.com is a PRIVATE-section public suffix)', () => {
    expect(isSameCompanyDomain('owner@shop1.myshopify.com', 'https://shop2.myshopify.com')).toBe(false);
    expect(normalizeCompanyDomain('https://shop1.myshopify.com/collections')).toBe('shop1.myshopify.com');
  });
  it('website = admin email domain holds across a multi-part ICANN suffix the old list lacked (com.sg)', () => {
    expect(isSameCompanyDomain('jane@acme.com.sg', 'https://www.acme.com.sg')).toBe(true);
    expect(isSameCompanyDomain('jane@acme.com.sg', 'https://www.other.com.sg')).toBe(false);
  });
});

// 7c 2026-11-19 (FINDING 2): a stale PSL silently re-introduces the defect this change fixes - a platform's PRIVATE
// suffix added upstream after the vendor date is missing, so two organisations collapse to one root. Make the age
// VISIBLE: this fails once the snapshot is older than the refresh window. Remedy (one command, verifiable): replace
// publicSuffixList.dat + meta.json from the source, then `node scripts/generate-public-suffix-rules.js` - the generator
// reproduces the generated file byte-for-byte, so the refresh is mechanical and reviewable.
describe('vendored PSL snapshot is fresh', () => {
  const REFRESH_WINDOW_DAYS = 120;   // quarterly refresh + a month of slack
  it(`retrievedAt is within ${REFRESH_WINDOW_DAYS} days (else refresh: see publicSuffixList.meta.json "refresh")`, () => {
    const meta = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'lib/shared/domain/publicSuffixList.meta.json'), 'utf8'));
    const retrieved = new Date(`${meta.retrievedAt}T00:00:00Z`).getTime();
    expect(Number.isFinite(retrieved)).toBe(true);
    const ageDays = (Date.now() - retrieved) / 86_400_000;
    expect(ageDays).toBeLessThanOrEqual(REFRESH_WINDOW_DAYS);
  });
});
