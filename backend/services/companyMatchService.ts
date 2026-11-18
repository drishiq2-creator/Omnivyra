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
 * Match priority:
 *   1. companies.website_domain == user email domain  (indexed, primary)
 *   2. companies.admin_email_domain == user email domain  (fallback for companies
 *      created without a real website URL)
 * Free/public email providers (gmail, yahoo, …) are never matched by domain, and a company name or a
 * typed website never matches at all (CI-231) - see findCompaniesByVerifiedEmailDomain.
 */

import { supabase } from '../db/supabaseClient';
// Canonical free/public-provider list — single source of truth shared with
// the signup validators (AUTH-001 Section 5). Previously this file carried
// its own divergent copy.
import { isPublicEmailDomain } from '../../lib/auth/publicEmailDomains';
import { normalizeCompanyDomain } from '../../lib/shared/domain/companyDomain';

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

/** A company reached by the requester's verified email domain. */
export type VerifiedDomainCompany = {
  company_id: string;
  company_name: string;
};

/**
 * `ok: false` = the lookup itself failed (a failed read is never "no company").
 * `domain` = the registrable domain that was looked up, or null when the email has no usable
 * corporate domain (free / public provider, malformed) - then nothing can match.
 */
export type VerifiedDomainLookup =
  | { ok: true; domain: string | null; companies: VerifiedDomainCompany[] }
  | { ok: false };

/**
 * CI-231 exact-domain binding (owner + coordinator ruling, 2026-11-19): the ONLY way a signing-up user
 * reaches an existing company is their own VERIFIED email domain. A company name or a website the user
 * typed never matches anything (the former name / entered-website steps let anyone with a verified
 * non-free email learn another company's id, name and admin).
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
  const domain = normalizeCompanyDomain(verifiedEmail);
  if (!host || !domain || isFreeEmailDomain(host) || isFreeEmailDomain(domain)) {
    return { ok: true, domain: null, companies: [] };
  }
  const escapedRoot = domain.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, '_');
  const byId = new Map<string, VerifiedDomainCompany>();
  for (const column of ['website_domain', 'admin_email_domain'] as const) {
    for (const pattern of [escapedRoot, `%.${escapedRoot}`]) {
      const { data, error } = await ownedDbTable('companies')
        .select(`id, name, ${column}`)
        .ilike(column, pattern)
        .is('deleted_at', null)
        .limit(MAX_DOMAIN_CANDIDATES);
      if (error) return { ok: false };
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        const stored = row?.[column];
        if (row?.id == null || typeof stored !== 'string' || normalizeCompanyDomain(stored) !== domain) continue;
        byId.set(String(row.id), { company_id: String(row.id), company_name: String(row.name ?? '') });
      }
    }
  }
  return { ok: true, domain, companies: [...byId.values()] };
}
