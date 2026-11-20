/**
 * Dropped-error rows websiteSetupService:25/:48 (cb, 2026-11-20) + POST /api/websites duplicate (7c).
 * A failed setup read used to answer 200 { website: null, progress: null } = "brand-new site" to the wizard.
 * Now getOrCreateWebsiteSetup throws WebsiteSetupReadError, and GET /api/websites/setup answers 503
 * WEBSITE_SETUP_UNAVAILABLE. A genuinely new company (no websites) is still 200 { website: null }.
 * Deps mocked; no DB.
 */
type Result = { data: unknown; error: unknown };
let byTable: Record<string, Result[]> = {};
jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: (table: string) => {
    const next = () => {
      const q = byTable[table] ?? [{ data: null, error: null }];
      return Promise.resolve(q.length > 1 ? q.shift()! : q[0]);
    };
    const b: Record<string, unknown> = {};
    const ret = () => b;
    b.select = ret; b.eq = ret; b.is = ret; b.insert = ret; b.update = ret;
    b.order = () => next();
    b.maybeSingle = () => next();
    b.single = () => next();
    (b as any).then = undefined;
    return b;
  },
}));
jest.mock('../../services/integrationHealthService', () => ({ getWebsiteHealthSummary: jest.fn(async () => ({})) }));
jest.mock('../../services/domainRecordService', () => ({ saveDomainRecord: jest.fn() }));
jest.mock('../../services/domainCanonicalService', () => ({ normalizeDomain: (h: string) => h }));

import { WebsiteSetupReadError, getOrCreateWebsiteSetup } from '../../services/websiteSetupService';

const W = { id: 'w1', company_id: 'co', canonical_url: 'https://a.test' };

describe('getOrCreateWebsiteSetup reads', () => {
  beforeEach(() => { byTable = {}; });

  it('a failed websites list read throws WebsiteSetupReadError (not "no website")', async () => {
    byTable = { websites: [{ data: null, error: { message: 'timeout' } }] };
    await expect(getOrCreateWebsiteSetup({ companyId: 'co' })).rejects.toBeInstanceOf(WebsiteSetupReadError);
  });

  it('a failed single-website read (website_id given) throws WebsiteSetupReadError', async () => {
    byTable = { websites: [{ data: null, error: { message: 'timeout' } }] };
    await expect(getOrCreateWebsiteSetup({ companyId: 'co', websiteId: 'w1' })).rejects.toBeInstanceOf(WebsiteSetupReadError);
  });

  it('a failed progress read throws instead of inserting a fresh (step-1) progress row', async () => {
    byTable = {
      websites: [{ data: [W], error: null }],
      website_setup_progress: [{ data: null, error: { message: 'timeout' } }, { data: { id: 'new' }, error: null }],
    };
    await expect(getOrCreateWebsiteSetup({ companyId: 'co' })).rejects.toBeInstanceOf(WebsiteSetupReadError);
  });

  it('control: a company with no websites is a real answer (website null), not an error', async () => {
    byTable = { websites: [{ data: [], error: null }] };
    await expect(getOrCreateWebsiteSetup({ companyId: 'co' })).resolves.toEqual({ website: null, progress: null });
  });

  it('control: existing progress is returned', async () => {
    byTable = {
      websites: [{ data: [W], error: null }],
      website_setup_progress: [{ data: { id: 'p1', completed_steps: ['create_website'] }, error: null }],
    };
    await expect(getOrCreateWebsiteSetup({ companyId: 'co' })).resolves.toEqual(
      expect.objectContaining({ progress: expect.objectContaining({ id: 'p1' }) }),
    );
  });
});
