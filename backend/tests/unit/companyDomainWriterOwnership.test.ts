/**
 * The live unique index (20270217000063) enforces one live company per STORED domain value. The app's
 * notion of "same domain" is the registrable root (normalizeCompanyDomain). The two agree only because
 * every writer of companies.website_domain / admin_email_domain stores the normalised root (or null).
 * A writer that stored a raw host ('mail.acme.com') beside 'acme.com' would pass the index and recreate
 * the two-live-companies state CI-309's 409 refuses (7c review of 20270217000063).
 *
 * This walks the source tree for writes to `companies` whose payload names either column, and requires
 * each writer to be listed with a CHECKABLE premise (the value is normalised or a literal null). A new
 * writer fails until reviewed; an existing writer that drops its normalisation fails its premise.
 * SURFACE, not column names (7c): a payload held in a VARIABLE names no column, so EVERY write to
 * `companies` whose payload is not an inline object literal must also be listed (VARIABLE_WRITERS), with a
 * premise saying where the record comes from. A new variable-payload write fails until reviewed.
 * OMISSION class (89, 2026-11-19): a write that names `website` but OMITS website_domain names no domain
 * column, so the inline list above cannot see it - yet it stores a website the unique index and every
 * website-only lookup cannot see (super-admin/companies POST did exactly that). Every inline write to
 * `companies` that names `website` must also name `website_domain`; a variable payload must be listed.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const DIRS = ['pages', 'backend', 'lib'];

const WRITERS: Record<string, { premise: RegExp[]; why: string }> = {
  'backend/services/companyIdentityWriter.ts': {
    premise: [/website_domain = rawDomain \? normalizeCompanyDomain\(rawDomain\)/, /admin_email_domain = rawAdmin \? normalizeCompanyDomain\(rawAdmin\)/],
    why: 'the canonical writer; normalises both columns before insert/update',
  },
  'pages/api/admin/create-company.ts': {
    premise: [/website_domain:\s*websiteDomain,/, /const websiteDomain = domainList\[0\] \? \(normalizeCompanyDomain\(domainList\[0\]\) \|\| null\) : null;/],
    why: 'super-admin create; stores the normalised root of the first domain',
  },
};

/** Writes to `companies` whose payload is a VARIABLE (file:op), keyed by file with the expected count. */
const VARIABLE_WRITERS: Record<string, { count: number; premise: RegExp[]; why: string }> = {
  'backend/services/companyIdentityWriter.ts': {
    count: 2,
    premise: [/website_domain = rawDomain \? normalizeCompanyDomain\(rawDomain\)/, /\.from\('companies'\)\.insert\(record\)/],
    why: 'insert(record) / update(patch): record and patch are built by buildCompanyIdentity, which normalises',
  },
  'pages/api/onboarding/complete.ts': {
    count: 1,
    premise: [/insertCompany: async \(record\) =>/, /websiteDomain:\s*founderRoot,/, /adminEmailDomain: founderRoot,/, /const founderRoot = publicEmailDomain \? '' : normalizeCompanyDomain\(emailDomain\);/],
    why: 'founder path (owner ruling 2026-11-19): the insertCompany callback handed to companyIdentityWriter inserts the record the writer built; website_domain = admin_email_domain = the normalised email root',
  },
  'backend/services/companyWebsiteCreation.ts': {
    count: 1,
    premise: [
      /insertCompany: async \(record\) =>/,
      /await createCompanyIdentity\(/,
      /websiteDomain: input\.website, adminEmailDomain: input\.adminEmailDomain/,
      /const website = normalizePublicWebsite\(text\);/,
    ],
    why: 'the ONE company-from-a-website creator (approve.ts, super-admin/companies POST): the insertCompany callback handed to companyIdentityWriter inserts the record the writer built; website_domain = the writer-normalised root of the normalised website',
  },
  'pages/api/onboarding/setup-company.ts': {
    count: 1,
    premise: [/insertCompany: async \(record\) =>/],
    why: 'the insertCompany callback handed to companyIdentityWriter: it inserts the record the writer built',
  },
};

/** Writes to `companies` whose payload is not an inline object/array literal. */
export function variablePayloadWrites(src: string): number {
  let n = 0;
  const re = /(?:\.from|ownedDbTable|tenantTable)\(\s*['"]companies['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const tail = src.slice(m.index, m.index + 900);
    const next = tail.slice(10).search(/(?:\.from|ownedDbTable|tenantTable)\(/);
    const chain = next >= 0 ? tail.slice(0, next + 10) : tail;
    const w = /\.(insert|update|upsert)\(\s*(\S)/.exec(chain);
    if (w && w[2] !== '{' && w[2] !== '[') n += 1;
  }
  return n;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'tests' || e.name === '__tests__' || e.name === '__mocks__') continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Writes to `companies` whose inline payload names a domain column. */
export function inlineDomainWrites(src: string): number {
  let n = 0;
  const re = /(?:\.from|ownedDbTable|tenantTable)\(\s*['"]companies['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const tail = src.slice(m.index, m.index + 900);
    const next = tail.slice(10).search(/(?:\.from|ownedDbTable|tenantTable)\(/);
    const chain = next >= 0 ? tail.slice(0, next + 10) : tail;
    const w = chain.search(/\.(insert|update|upsert)\(/);
    if (w >= 0 && /\b(website_domain|admin_email_domain)\s*:/.test(chain.slice(w))) n += 1;
  }
  return n;
}

/** The argument text of the write call starting at `open` (the index of its '('), by paren depth. */
function callArgument(chain: string, open: number): string {
  let depth = 0;
  for (let i = open; i < chain.length; i++) {
    if (chain[i] === '(') depth += 1;
    else if (chain[i] === ')') { depth -= 1; if (depth === 0) return chain.slice(open + 1, i); }
  }
  return chain.slice(open + 1);
}

/** Inline writes to `companies` whose payload names `website` (key or shorthand) but not `website_domain`. */
export function websiteWithoutDomainWrites(src: string): number {
  let n = 0;
  const re = /(?:\.from|ownedDbTable|tenantTable)\(\s*['"]companies['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const tail = src.slice(m.index, m.index + 900);
    const next = tail.slice(10).search(/(?:\.from|ownedDbTable|tenantTable)\(/);
    const chain = next >= 0 ? tail.slice(0, next + 10) : tail;
    const w = /\.(insert|update|upsert)\(/.exec(chain);
    if (!w) continue;
    const arg = callArgument(chain, w.index + w[0].length - 1);
    const names = (col: string) => new RegExp(`(?:^|[{,\\s])${col}\\s*(?::|,|\\}|$)`).test(arg);
    if (names('website') && !names('website_domain')) n += 1;
  }
  return n;
}

describe('companies domain columns: every writer stores the normalised root', () => {
  const files = DIRS.flatMap((d) => walk(path.join(ROOT, d)));
  const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/');

  it('scans a real tree (non-vacuous)', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it('every inline writer is listed, and the list has no stale entries', () => {
    const found = files.filter((f) => inlineDomainWrites(fs.readFileSync(f, 'utf8')) > 0).map(rel).sort();
    expect(found.length).toBeGreaterThanOrEqual(1); // create-company (complete.ts and approve.ts now go through the writer)
    expect(found).toContain('pages/api/admin/create-company.ts'); // non-vacuous: the scanner still sees the inline writer
    const listedInline = Object.keys(WRITERS).filter((k) => k !== 'backend/services/companyIdentityWriter.ts').sort();
    expect({ unlisted: found.filter((f) => !WRITERS[f]), stale: listedInline.filter((k) => !found.includes(k)) })
      .toEqual({ unlisted: [], stale: [] });
  });

  it.each(Object.entries(WRITERS))('%s keeps its premise', (file, { premise }) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const p of premise) expect(src).toMatch(p);
  });

  it('every VARIABLE-payload write to companies is listed with its exact count (surface, not columns)', () => {
    const found: Record<string, number> = {};
    for (const f of files) { const n = variablePayloadWrites(fs.readFileSync(f, 'utf8')); if (n > 0) found[rel(f)] = n; }
    expect(Object.keys(found).length).toBeGreaterThan(0);
    const expected = Object.fromEntries(Object.entries(VARIABLE_WRITERS).map(([k, v]) => [k, v.count]));
    expect(found).toEqual(expected);
  });

  it.each(Object.entries(VARIABLE_WRITERS))('%s (variable payload) keeps its premise', (file, { premise }) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const p of premise) expect(src).toMatch(p);
  });

  it('MUTANTS: the scanner sees an unlisted inline writer, and ignores reads', () => {
    expect(inlineDomainWrites(`await supabase.from('companies').insert({ name, website_domain: host })`)).toBe(1);
    expect(inlineDomainWrites(`await ownedDbTable('companies').update({ admin_email_domain: d }).eq('id', id)`)).toBe(1);
    expect(inlineDomainWrites(`await supabase.from('companies').select('id, website_domain').eq('id', id)`)).toBe(0);
    expect(inlineDomainWrites(`await supabase.from('companies').insert({ name }); await supabase.from('reports').insert({ website_domain: d })`)).toBe(0);
    expect(variablePayloadWrites(`await supabase.from('companies').update(payload).eq('id', id)`)).toBe(1);
    expect(variablePayloadWrites(`await supabase.from('companies').update({ status }).eq('id', id)`)).toBe(0);
  });

  it('every caller of insertCompanyWithWebsite passes a normalised admin_email_domain (or a literal null)', () => {
    const callers = files.filter((f) => /insertCompanyWithWebsite\(/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
    expect(callers).toEqual([
      'backend/services/companyWebsiteCreation.ts',
      'pages/api/admin/access-requests/approve.ts',
      'pages/api/super-admin/companies.ts',
    ]);
    const approve = fs.readFileSync(path.join(ROOT, 'pages/api/admin/access-requests/approve.ts'), 'utf8');
    expect(approve).toMatch(/const emailRoot = normalizeCompanyDomain\(String\(request\.email \?\? ''\)\);/);
    expect(approve).toMatch(/const adminEmailDomain = freeMail \? null : emailRoot;/);
    const superAdmin = fs.readFileSync(path.join(ROOT, 'pages/api/super-admin/companies.ts'), 'utf8');
    expect(superAdmin).toMatch(/insertCompanyWithWebsite\(\{[\s\S]{0,400}?adminEmailDomain: null,/);
  });

  it('OMISSION: no inline write to companies names `website` without `website_domain`', () => {
    const found = files.filter((f) => websiteWithoutDomainWrites(fs.readFileSync(f, 'utf8')) > 0).map(rel).sort();
    expect(found).toEqual([]);
  });

  it('MUTANTS: the omission scanner sees "website without website_domain" (key and shorthand), and nothing else', () => {
    expect(websiteWithoutDomainWrites(`await supabase.from('companies').insert({ name, website: normalizedWebsite, status: 'active' }).select('*')`)).toBe(1);
    expect(websiteWithoutDomainWrites(`await supabase.from('companies').update({ website }).eq('id', id)`)).toBe(1);
    expect(websiteWithoutDomainWrites(`await ownedDbTable('companies').upsert([{ id, website: w }])`)).toBe(1);
    expect(websiteWithoutDomainWrites(`await supabase.from('companies').insert({ name, website: w, website_domain: d })`)).toBe(0);
    expect(websiteWithoutDomainWrites(`await supabase.from('companies').update({ website, website_domain }).eq('id', id)`)).toBe(0);
    expect(websiteWithoutDomainWrites(`await supabase.from('companies').select('id, website').eq('website', w)`)).toBe(0);
    expect(websiteWithoutDomainWrites(`await supabase.from('companies').insert({ name, website_url: w })`)).toBe(0);
    expect(websiteWithoutDomainWrites(`await supabase.from('companies').insert({ name }); await supabase.from('company_profiles').insert({ website: w })`)).toBe(0);
  });
});
