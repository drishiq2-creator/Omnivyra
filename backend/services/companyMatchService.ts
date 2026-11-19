import { ownedDbTable } from '../db/writeOwner';
/**
 * Company Match Service
 *
 * Detects whether a newly-signing-up user belongs to an existing company
 * by comparing the user's email domain against the company's website domain.
 *
 * Example:
 *   Company website: www.drishiq.com  →  stored website_domain = "drishiq.com"
 *   New user email:  jane@drishiq.com  →  email domain = "drishiq.com"
 *   → Match found → user added as CONTENT_CREATOR, company admin notified.
 *
 * Match key (owner ruling, 2026-11-19): companies.website_domain ONLY. A company's identity is its
 * WEBSITE domain (one live company per registrable website domain, enforced by
 * idx_companies_website_domain_unique, 20270217000063). admin_email_domain is a stored attribute that
 * several companies MAY share (e.g. alpha.test and beta.test both administered from shared.test), so it is
 * never a match key: a shared admin email domain claims nothing.
 * Free/public email providers (gmail, yahoo, …) are never matched by domain, and a company name or a
 * typed website never matches at all (CI-231) - see findCompaniesByVerifiedEmailDomain.
 */

import { supabase } from '../db/supabaseClient';
// Canonical free/public-provider list — single source of truth shared with
// the signup validators (AUTH-001 Section 5). Previously this file carried
// its own divergent copy.
import { isPublicEmailDomain } from '../../lib/auth/publicEmailDomains';
import { normalizeCompanyDomain } from '../../lib/shared/domain/companyDomain';
import { isPublicSuffix } from '../../lib/shared/domain/publicSuffix';
import { logger } from './logger';

/** Extract the domain portion from a URL or email address, stripping www. */
export function extractDomain(input: string): string | null {
  if (!input?.trim()) return null;
  try {
    const raw = input.trim().toLowerCase();
    // Email address (contains @)
    if (raw.includes('@')) {
      const after = raw.split('@').pop()?.trim();
      return after || null;
    }
    // URL — ensure protocol prefix for URL constructor
    const url = raw.startsWith('http') ? raw : `https://${raw}`;
    const { hostname } = new URL(url);
    return hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** True when the domain belongs to a free/public email provider. */
export function isFreeEmailDomain(domain: string): boolean {
  return isPublicEmailDomain(domain);
}

const PRIVATE_DOMAIN_PATTERNS = [
  /^localhost$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\.0\.0\.0$/,
];

/**
 * Validates that a website URL is a real public URL, not localhost/IP/email domain.
 * Returns null if valid, or an error message string if invalid.
 */
export function validatePublicWebsite(website: string): string | null {
  if (!website?.trim()) return 'Company website is required.';
  let hostname: string;
  try {
    const url = website.trim().startsWith('http') ? website.trim() : `https://${website.trim()}`;
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'Please enter a valid website URL (e.g. yourcompany.com).';
  }
  if (!hostname || !hostname.includes('.')) {
    return 'Please enter a valid website URL with a domain (e.g. yourcompany.com).';
  }
  if (PRIVATE_DOMAIN_PATTERNS.some(p => p.test(hostname))) {
    return 'Please enter a public website URL, not a local or private address.';
  }
  if (isFreeEmailDomain(hostname)) {
    return 'Please enter your company website, not a personal email provider domain.';
  }
  return null;
}

/**
 * The stored form of a website a person typed (access requests, and the company a Super Admin opens
 * from one): `https://<host>`, host lower-cased with `www.` stripped - no path, query, port or
 * credentials. null when validatePublicWebsite refuses it (so the two can never disagree).
 */
export function normalizePublicWebsite(website: string | null | undefined): string | null {
  if (typeof website !== 'string' || validatePublicWebsite(website) !== null) return null;
  const raw = website.trim();
  const host = new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, '');
  return `https://${host}`;
}

/** A company reached by the requester's verified email domain. */
export type VerifiedDomainCompany = {
  company_id: string;
  company_name: string;
};

/**
 * `ok: false` = the lookup itself failed (a failed read is never "no company").
 * `domain` = the registrable domain that was looked up, or null when the email has no usable
 * corporate domain (free / public provider, malformed) - then nothing can match.
 * `ambiguous: true` = no decision is possible (the root is empty or itself a public suffix, or a
 * candidate query hit the cap); every caller answers it exactly like several matches: 409
 * COMPANY_DOMAIN_AMBIGUOUS, never a match.
 */
export type VerifiedDomainLookup =
  | { ok: true; domain: string | null; companies: VerifiedDomainCompany[]; ambiguous?: true }
  | { ok: false };

/**
 * CI-231 exact-domain binding (owner + coordinator ruling, 2026-11-19): the ONLY way a signing-up user
 * reaches an existing company is their own VERIFIED email domain. A company name or a website the user
 * typed never matches anything (the former name / entered-website steps let anyone with a verified
 * non-free email learn another company's id, name and admin).
 *
 * Only companies.website_domain is compared (owner ruling 2026-11-19: identity = website domain; a shared
 * ADMIN email domain claims nothing - see the file header). Self-signup requires the email root to equal
 * the website root, so the verified email root is looked up as a website domain.
 *
 * The comparison key is the registrable ROOT from lib/shared/domain/companyDomain
 * (normalizeCompanyDomain), applied to BOTH sides: the root is what companyIdentityWriter STORES, and a
 * legacy / pre-writer row stamped with a HOST (mail.acme.com) normalizes to the same root (c6 review,
 * 2026-11-19: such a row must still be found, or its domain's next user is offered a duplicate company).
 * acme.co.uk and foo.co.uk stay distinct. Candidates are fetched by the exact root and by the subdomain
 * suffix `%.<root>` (the root's own % _ \ are escaped, so the leading % is the only wildcard); the
 * DECISION is normalizeCompanyDomain(stored) === root in code, case-insensitive. Soft-deleted companies (deleted_at set) are out of
 * both the match and the ambiguity count (7c); inactive / suspended companies stay IN (excluding them
 * would let a second company appear on their domain). ALL matching companies are returned (bounded) so
 * the caller can refuse an ambiguous domain instead of guessing.
 */
const MAX_DOMAIN_CANDIDATES = 10;
export async function findCompaniesByVerifiedEmailDomain(
  verifiedEmail: string | null | undefined,
): Promise<VerifiedDomainLookup> {
  const host = extractDomain(verifiedEmail ?? '');
  if (!host || isFreeEmailDomain(host)) return { ok: true, domain: null, companies: [] };
  const domain = normalizeCompanyDomain(verifiedEmail);
  // PSL guard (7c, 2026-11-19): a public suffix (co.il, github.io, com.sg) is never a company domain -
  // matching on it would bind strangers to one company. Ambiguous, never a match; decided before any read.
  if (!domain || isPublicSuffix(domain)) {
    logger.warn('verified_domain_lookup_public_suffix', { host });
    return { ok: true, domain: domain || host, companies: [], ambiguous: true };
  }
  // Not dead code: this second free-mail check is on the ROOT (mail.provider.com -> provider.com). Order matters:
  // a free-mail provider whose HOST is unlisted but whose root is itself a public suffix is refused above (409)
  // before this check can rescue it, so isFreeEmailDomain's completeness also decides whether such individuals
  // can onboard (fail closed; 7c, 2026-11-19).
  if (isFreeEmailDomain(domain)) return { ok: true, domain: null, companies: [] };
  return findLiveCompaniesByWebsiteRoot(domain);
}

/**
 * Vetted path (owner ruling 2026-11-19): the SAME live-company lookup keyed by a WEBSITE instead of an
 * email - used where a Super Admin opens a company for an approved access request, to refuse a website
 * domain a live company already holds (one live company per website domain). The website is reduced to
 * its registrable root exactly like a stored website_domain (normalizeCompanyDomain); a website with no
 * root, or whose root is a public suffix, is undecidable -> ambiguous (never "free"). Free-mail roots are
 * NOT special-cased here: a website is not an email, and a company holding such a root still holds it.
 */
export async function findCompaniesByWebsiteDomain(
  website: string | null | undefined,
): Promise<VerifiedDomainLookup> {
  const domain = normalizeCompanyDomain(website);
  if (!domain || isPublicSuffix(domain)) {
    return { ok: true, domain: domain || null, companies: [], ambiguous: true };
  }
  return findLiveCompaniesByWebsiteRoot(domain);
}

/** Live companies whose stored website_domain normalises to `domain` (already a registrable root). */
async function findLiveCompaniesByWebsiteRoot(domain: string): Promise<VerifiedDomainLookup> {
  // `*` -> `_`: PostgREST accepts `*` as an alias of the `%` wildcard in like/ilike, so a literal `*`
  // must not reach the pattern. A domain cannot contain `*`, and `_` matches exactly one character, so
  // this only ever NARROWS the candidate set (the decision below is exact anyway).
  const escapedRoot = domain.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, '_');
  const byId = new Map<string, VerifiedDomainCompany>();
  let capHit = false;
  for (const pattern of [escapedRoot, `%.${escapedRoot}`]) {
    // The leading-wildcard ILIKE can never use a btree index. If this ever needs optimising, the right
    // fix is a stored normalized-root column maintained by companyIdentityWriter with a plain btree
    // index (which also removes the suffix pattern) - NOT an index on the raw domain columns.
    const { data, error } = await ownedDbTable('companies')
      .select('id, name, website_domain')
      .ilike('website_domain', pattern)
      .is('deleted_at', null)
      .limit(MAX_DOMAIN_CANDIDATES);
    if (error) return { ok: false };
    // A full page is potentially incomplete: never decide on it.
    if ((data ?? []).length >= MAX_DOMAIN_CANDIDATES) capHit = true;
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const stored = row?.website_domain;
      if (row?.id == null || typeof stored !== 'string' || normalizeCompanyDomain(stored) !== domain) continue;
      byId.set(String(row.id), { company_id: String(row.id), company_name: String(row.name ?? '') });
    }
  }
  if (capHit) {
    logger.warn('verified_domain_lookup_cap_hit', { domain, cap: MAX_DOMAIN_CANDIDATES });
    return { ok: true, domain, companies: [], ambiguous: true };
  }
  return { ok: true, domain, companies: [...byId.values()] };
}
