/**
 * companyWebsiteCreation.ts - ONE way to open a company from a website someone typed or approved
 * (owner ruling 2026-11-19: a company's identity is its WEBSITE domain; one LIVE company per website
 * domain). Used by the Super Admin surfaces that create a company from a website:
 *   - pages/api/admin/access-requests/approve.ts (the vetted path)
 *   - pages/api/super-admin/companies.ts POST
 *
 * Two steps, so a caller can check before it claims anything and create after:
 *   1. checkCompanyWebsite(raw)  - normalise (normalizePublicWebsite) and refuse a website domain a live
 *      company already holds. READ-ONLY: every refusal means nothing was written.
 *   2. insertCompanyWithWebsite  - create through companyIdentityWriter (website + website_domain written
 *      together, both normalised: invariants A/B/D); a concurrent create that wins
 *      idx_companies_website_domain_unique (23505) is the same COMPANY_WEBSITE_TAKEN refusal.
 */
import { supabase } from '../db/supabaseClient';
import { createCompanyIdentity, CompanyIdentityInvariantError } from './companyIdentityWriter';
import { findCompaniesByWebsiteDomain, normalizePublicWebsite } from './companyMatchService';

export type CompanyWebsiteRefusal = {
  ok: false;
  status: 409 | 422 | 500 | 503;
  code: 'COMPANY_WEBSITE_TAKEN' | 'COMPANY_WEBSITE_AMBIGUOUS' | 'COMPANY_WEBSITE_INVALID' | 'COMPANY_WEBSITE_CHECK_FAILED' | 'COMPANY_CREATE_FAILED';
  error: string;
};

export const WEBSITE_REFUSALS = {
  taken:     { ok: false, status: 409, code: 'COMPANY_WEBSITE_TAKEN', error: 'A company with this website already exists.' },
  ambiguous: { ok: false, status: 409, code: 'COMPANY_WEBSITE_AMBIGUOUS', error: 'This website cannot identify a single company. Choose another website.' },
  invalid:   { ok: false, status: 422, code: 'COMPANY_WEBSITE_INVALID', error: 'The website is not a valid public company website.' },
  check:     { ok: false, status: 503, code: 'COMPANY_WEBSITE_CHECK_FAILED', error: 'Could not check the website. Please try again.' },
  create:    { ok: false, status: 500, code: 'COMPANY_CREATE_FAILED', error: 'Failed to create the company.' },
} as const satisfies Record<string, CompanyWebsiteRefusal>;

/**
 * Normalise a raw website and refuse one a LIVE company already holds. A missing website (null / blank)
 * is allowed when `required` is false (a free-mail vetted company may have none) -> website null.
 */
export async function checkCompanyWebsite(
  raw: unknown,
  opts: { required: boolean },
): Promise<{ ok: true; website: string | null } | CompanyWebsiteRefusal> {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return opts.required ? WEBSITE_REFUSALS.invalid : { ok: true, website: null };
  const website = normalizePublicWebsite(text);
  if (!website) return WEBSITE_REFUSALS.invalid;
  const held = await findCompaniesByWebsiteDomain(website);
  if (!held.ok) return WEBSITE_REFUSALS.check;
  if (held.ambiguous) return WEBSITE_REFUSALS.ambiguous;
  if (held.companies.length > 0) return WEBSITE_REFUSALS.taken;
  return { ok: true, website };
}

/**
 * Create the company through companyIdentityWriter. `website` must come from checkCompanyWebsite
 * (normalised, or null); website_domain is its registrable root, written by the writer. Returns the
 * inserted row (select '*').
 */
export async function insertCompanyWithWebsite(input: {
  record: Record<string, unknown>;
  website: string | null;
  adminEmailDomain: string | null;
}): Promise<{ ok: true; row: Record<string, unknown> } | CompanyWebsiteRefusal> {
  const inserted: { row: Record<string, unknown> | null } = { row: null };
  try {
    await createCompanyIdentity(
      { ...input.record, website: input.website, websiteDomain: input.website, adminEmailDomain: input.adminEmailDomain },
      {
        insertCompany: async (record) => {
          const { data, error } = await supabase.from('companies').insert(record).select('*').single();
          if (error || !data) {
            const e = new Error(error?.message ?? 'company insert failed') as Error & { code?: string };
            e.code = error?.code;
            throw e;
          }
          inserted.row = data as Record<string, unknown>;
          return { id: String((data as { id: string }).id) };
        },
      },
    );
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') return WEBSITE_REFUSALS.taken;
    if (err instanceof CompanyIdentityInvariantError) return WEBSITE_REFUSALS.invalid;
    console.error('[companyWebsiteCreation] company insert failed:', (err as Error)?.message);
    return WEBSITE_REFUSALS.create;
  }
  if (!inserted.row) return WEBSITE_REFUSALS.create;
  return { ok: true, row: inserted.row };
}
