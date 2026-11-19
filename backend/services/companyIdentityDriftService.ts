/**
 * companyIdentityDriftService.ts
 *
 * TELEMETRY-ONLY integrity monitor for company identity drift. Detects when
 * website / website_domain become inconsistent (over time, via imports, manual
 * edits, migrations, or bugs).
 *
 * This NEVER blocks, NEVER auto-corrects, NEVER mutates data. It only detects
 * and emits a structured COMPANY_IDENTITY_DRIFT_WARNING telemetry event.
 *
 * Canonical identity rule (owner ruling 2026-11-19): a company's identity is its
 * WEBSITE domain. Drift = a violation of the companyIdentityWriter invariants only:
 *   - website IS NULL <=> website_domain IS NULL (a company may have neither);
 *   - website_domain is the normalised registrable root, and it is the root of website.
 * admin_email_domain is NOT part of the identity: several companies may share one, a
 * free-mail company has none, and admin root != website root is legal - never drift.
 * Normalization reuses the SINGLE source of truth —
 * lib/shared/domain/companyDomain.normalizeCompanyDomain.
 */

import { normalizeCompanyDomain } from '../../lib/shared/domain/companyDomain';
import { logger } from './logger';

export type CompanyIdentityInput = {
  id?: string | null;
  company_id?: string | null;
  name?: string | null;
  admin_email_domain?: string | null;
  website_domain?: string | null;
  website?: string | null;
};

export type CompanyIdentityDriftReason =
  | 'MISSING_WEBSITE_DOMAIN'          // website set, website_domain missing (Invariant B)
  | 'MISSING_WEBSITE'                 // website_domain set, website missing or a UUID placeholder (Invariant A)
  | 'INVALID_WEBSITE_DOMAIN'          // website_domain set but not a parseable domain
  | 'INVALID_WEBSITE_FORMAT'          // website set but no domain can be extracted
  | 'WEBSITE_DOMAIN_NOT_NORMALIZED'   // website_domain is not its own registrable root (Invariant C)
  | 'WEBSITE_DOMAIN_MISMATCH';        // website_domain is not the root of website

export type CompanyIdentityDriftResult = {
  hasDrift: boolean;
  companyId: string;
  companyName: string;
  adminEmailDomain: string | null;
  websiteDomain: string | null;
  website: string | null;
  driftReasons: CompanyIdentityDriftReason[];
};

export const COMPANY_IDENTITY_DRIFT_EVENT = 'COMPANY_IDENTITY_DRIFT_WARNING';

const nonEmpty = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim() !== '';
const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v.trim());

/**
 * Pure drift evaluation. No I/O, no side effects. Reuses the canonical
 * normalizer; does NOT define its own.
 */
export function checkCompanyIdentityDrift(company: CompanyIdentityInput): CompanyIdentityDriftResult {
  const companyId = String(company.id ?? company.company_id ?? '');
  const companyName = String(company.name ?? '');
  const adminEmailDomain = nonEmpty(company.admin_email_domain) ? company.admin_email_domain.trim() : null;
  const websiteDomain = nonEmpty(company.website_domain) ? company.website_domain.trim() : null;
  const website = nonEmpty(company.website) ? company.website.trim() : null;

  const reasons: CompanyIdentityDriftReason[] = [];

  // A UUID in website is a legacy placeholder, never a website.
  const realWebsite = website && !isUuid(website) ? website : null;
  if (website && !realWebsite) reasons.push('MISSING_WEBSITE');

  // Invariants A/B: website and website_domain are both set or both null.
  if (realWebsite && !websiteDomain) reasons.push('MISSING_WEBSITE_DOMAIN');
  if (websiteDomain && !website) reasons.push('MISSING_WEBSITE');

  const normWebsiteDomain = websiteDomain ? normalizeCompanyDomain(websiteDomain) : '';
  const normWebsite = realWebsite ? normalizeCompanyDomain(realWebsite) : '';

  // website_domain present but not a parseable domain; or parseable but not stored as its root (Invariant C).
  if (websiteDomain && normWebsiteDomain === '') reasons.push('INVALID_WEBSITE_DOMAIN');
  if (websiteDomain && normWebsiteDomain !== '' && normWebsiteDomain !== websiteDomain.toLowerCase()) {
    reasons.push('WEBSITE_DOMAIN_NOT_NORMALIZED');
  }

  // website present (and not a UUID placeholder) but no domain can be extracted.
  if (realWebsite && normWebsite === '') reasons.push('INVALID_WEBSITE_FORMAT');

  // website_domain must be the root of website. (admin_email_domain is never compared.)
  if (normWebsite && normWebsiteDomain && normWebsite !== normWebsiteDomain) reasons.push('WEBSITE_DOMAIN_MISMATCH');

  return {
    hasDrift: reasons.length > 0,
    companyId,
    companyName,
    adminEmailDomain,
    websiteDomain,
    website,
    driftReasons: reasons,
  };
}

/**
 * Emit the structured drift-warning telemetry event (only when drift exists).
 * Telemetry must never throw — all errors are swallowed.
 */
export function emitCompanyIdentityDriftWarning(result: CompanyIdentityDriftResult): void {
  if (!result.hasDrift) return;
  try {
    logger.warn(COMPANY_IDENTITY_DRIFT_EVENT, {
      companyId: result.companyId,
      companyName: result.companyName,
      adminEmailDomain: result.adminEmailDomain,
      websiteDomain: result.websiteDomain,
      website: result.website,
      driftReasons: result.driftReasons,
      detectedAt: new Date().toISOString(),
    });
  } catch {
    /* telemetry must never throw */
  }
}

/**
 * Check + emit in one fire-and-forget call. NEVER throws — safe to drop into any
 * company create/update path without risking the request. Returns the result for
 * callers that want it, or null if evaluation itself failed.
 */
export function monitorCompanyIdentityDrift(company: CompanyIdentityInput): CompanyIdentityDriftResult | null {
  try {
    const result = checkCompanyIdentityDrift(company);
    emitCompanyIdentityDriftWarning(result);
    return result;
  } catch {
    return null;
  }
}
