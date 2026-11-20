/**
 * U6 server half (b3, 2026-11-20): a duplicate website for the same company + address hits
 * uq_websites_company_canonical_url_active (23505). createWebsite now throws WebsiteAlreadyExistsError for THAT
 * index only, and POST /api/websites/setup {action:'create_website'} answers 409 WEBSITE_ALREADY_EXISTS instead of
 * a raw 500. Deps mocked; no DB.
 */
let insertResult: { data: unknown; error: unknown } = { data: null, error: null };
jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: () => {
    const b: Record<string, unknown> = {};
    const ret = () => b;
    b.select = ret; b.eq = ret; b.insert = ret; b.update = ret;
    b.single = () => Promise.resolve(insertResult);
    return b;
  },
}));

import {
  WEBSITE_CANONICAL_URL_UNIQUE,
  WebsiteAlreadyExistsError,
  createWebsite,
  isActiveCanonicalUrlConflict,
} from '../../services/websiteService';

const DUP = {
  code: '23505',
  message: `duplicate key value violates unique constraint "${WEBSITE_CANONICAL_URL_UNIQUE}"`,
  details: 'Key (company_id, lower(canonical_url))=(co, https://a.test) already exists.',
};

describe('createWebsite: the canonical-url unique violation is its own error', () => {
  it('23505 on uq_websites_company_canonical_url_active -> WebsiteAlreadyExistsError (message kept)', async () => {
    insertResult = { data: null, error: DUP };
    await expect(createWebsite({ companyId: 'co', name: 'A', canonicalUrl: 'https://a.test' } as any))
      .rejects.toEqual(expect.objectContaining({ name: 'WebsiteAlreadyExistsError', code: 'WEBSITE_ALREADY_EXISTS', message: DUP.message }));
  });

  it('control: a different unique violation stays a plain Error', async () => {
    insertResult = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "websites_pkey"' } };
    const err = await createWebsite({ companyId: 'co', name: 'A', canonicalUrl: 'https://a.test' } as any).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(WebsiteAlreadyExistsError);
  });

  it('control: a different URL (no conflict) creates', async () => {
    insertResult = { data: { id: 'w2', canonical_url: 'https://b.test' }, error: null };
    await expect(createWebsite({ companyId: 'co', name: 'B', canonicalUrl: 'https://b.test' } as any)).resolves.toEqual(
      expect.objectContaining({ id: 'w2' }),
    );
  });

  it('isActiveCanonicalUrlConflict needs both the code and the index name', () => {
    expect(isActiveCanonicalUrlConflict(DUP)).toBe(true);
    expect(isActiveCanonicalUrlConflict({ ...DUP, code: '23503' })).toBe(false);
    expect(isActiveCanonicalUrlConflict({ code: '23505', message: 'other index' })).toBe(false);
    expect(isActiveCanonicalUrlConflict(null)).toBe(false);
  });
});
