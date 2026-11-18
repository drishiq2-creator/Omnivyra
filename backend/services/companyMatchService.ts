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

export type CompanyAdmin = {
  user_id: string;
  email: string | null;
};

/**
 * CI-231 exact-domain binding (owner + coordinator ruling, 2026-11-19): the ONLY way a signing-up user
 * reaches an existing company is their own VERIFIED email domain. A company name or a website the user
 * typed never matches anything (the former name / entered-website steps let anyone with a verified
 * non-free email learn another company's id, name and admin).
 *
 * The comparison key is the registrable domain from lib/shared/domain/companyDomain
 * (normalizeCompanyDomain) - the same helper companyIdentityWriter uses to STORE
 * companies.website_domain / admin_email_domain, so equality here is equality of registrable domains
 * (acme.co.uk and foo.co.uk stay distinct). ALL matching companies are returned (bounded) so the
 * caller can refuse an ambiguous domain instead of guessing.
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
  const byId = new Map<string, VerifiedDomainCompany>();
  for (const column of ['website_domain', 'admin_email_domain'] as const) {
    const { data, error } = await ownedDbTable('companies')
      .select('id, name')
      .eq(column, domain)
      .limit(MAX_DOMAIN_CANDIDATES);
    if (error) return { ok: false };
    for (const row of (data ?? []) as Array<{ id?: unknown; name?: unknown }>) {
      if (row?.id == null) continue;
      byId.set(String(row.id), { company_id: String(row.id), company_name: String(row.name ?? '') });
    }
  }
  return { ok: true, domain, companies: [...byId.values()] };
}

/**
 * Get all active COMPANY_ADMIN users for a given company (for notifications).
 */
export async function getCompanyAdmins(companyId: string): Promise<CompanyAdmin[]> {
  const { data: roles } = await ownedDbTable('user_company_roles')
    .select('user_id')
    .eq('company_id', companyId)
    .eq('role', 'COMPANY_ADMIN')
    .eq('status', 'active');

  if (!roles?.length) return [];

  const admins: CompanyAdmin[] = [];
  for (const row of roles) {
    try {
      const { data: userData } = await ownedDbTable('users')
        .select('email')
        .eq('id', row.user_id)
        .maybeSingle();
      admins.push({ user_id: row.user_id, email: (userData as any)?.email ?? null });
    } catch {
      admins.push({ user_id: row.user_id, email: null });
    }
  }
  return admins;
}

/**
 * Insert an in-app notification for every COMPANY_ADMIN of the company,
 * informing them that a new user self-joined via domain match.
 */
export async function notifyCompanyAdminsOfSelfJoin(params: {
  companyId: string;
  companyName: string;
  newUserId: string;
  newUserEmail: string | null;
  matchType: 'website_domain' | 'admin_email_domain' | 'name';
}): Promise<void> {
  const { companyId, companyName, newUserId, newUserEmail, matchType } = params;

  const admins = await getCompanyAdmins(companyId);
  if (!admins.length) return;

  const emailDomain = newUserEmail ? extractDomain(newUserEmail) : null;
  const matchReason =
    matchType === 'website_domain'
      ? `company website (${companyName.toLowerCase().replace(/\s+/g, '')})`
      : matchType === 'admin_email_domain'
      ? `email domain (@${emailDomain ?? 'unknown'})`
      : `company name "${companyName}"`;

  const now = new Date().toISOString();
  const notifications = admins.map((admin) => ({
    user_id:    admin.user_id,
    type:       'self_join',
    title:      'New user joined your company',
    message:    `${newUserEmail ?? 'A new user'} signed up and was automatically added to ${companyName} as a Content Creator — matched by ${matchReason}. You can manage their access in Team Settings.`,
    metadata: {
      company_id:     companyId,
      new_user_id:    newUserId,
      new_user_email: newUserEmail,
      match_type:     matchType,
      joined_at:      now,
    },
    is_read:    false,
    created_at: now,
  }));

  const { error } = await ownedDbTable('notifications').insert(notifications);
  if (error) {
    console.error('[companyMatch] notification insert failed:', error.message);
  }
}
