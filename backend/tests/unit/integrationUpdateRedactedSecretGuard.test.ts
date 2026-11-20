/**
 * 04 (2026-11-20) — updateIntegration never stores a redacted placeholder as a secret.
 *
 * Non-admins now read integrations with secrets redacted to '********' (integrationSecretRedaction.ts), and a failed
 * role read answers redacted too. An edit form prefilled from such a read would PUT '********' back; without the
 * guard that string would be encrypted and stored over the real credential. This runs the REAL updateIntegration with
 * the DB and credential store faked, and asserts what reaches the credential write.
 */
const credentialWrites: Array<Record<string, string>> = [];
let stored: Record<string, unknown>;

jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: () => {
    const st: { op: string; payload?: Record<string, unknown> } = { op: 'select' };
    const chain: any = {
      select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
      update: (p: Record<string, unknown>) => { st.op = 'update'; st.payload = p; return chain; },
      single: async () => ({ data: st.op === 'update' ? { ...stored, ...st.payload } : stored, error: null }),
      then: (ok: any, ko: any) => Promise.resolve({ data: null, error: null }).then(ok, ko),
    };
    return chain;
  },
}));
jest.mock('../../services/integrationCredentialService', () => {
  const actual = jest.requireActual('../../services/integrationCredentialService');
  return {
    ...actual,
    // Hydration merges the DECRYPTED stored credential back in, as production does.
    mergeConnectionConfig: jest.fn(async (_c: string, _id: string, nonSecret: Record<string, string>) => ({ ...nonSecret, secret: 'whsec_REAL' })),
    upsertConnectionCredentials: jest.fn(async (_c: string, _id: string, creds: Record<string, string>) => { credentialWrites.push({ ...creds }); }),
  };
});
jest.mock('../../services/websiteService', () => ({ createWebsiteConnection: jest.fn(), resolveWebsiteForCompany: jest.fn() }));
jest.mock('../../services/cms/registry', () => ({ getCmsAdapter: jest.fn(), isCmsProvider: () => false }));
jest.mock('../../services/cms/cmsConnectionNormalizationService', () => ({ ensureCanonicalConnectionForIntegration: jest.fn() }));

import { updateIntegration } from '../../services/integrationService';

beforeEach(() => {
  credentialWrites.length = 0;
  stored = {
    id: 'int-1', company_id: 'co-A', created_by: 'u0', type: 'lead_webhook', name: 'Site form', status: 'connected',
    website_connection_id: 'conn-1', config: { site_url: 'https://a.example' }, non_secret_config: { site_url: 'https://a.example' },
  };
});

describe('updateIntegration × redacted placeholder', () => {
  it('a PUT carrying "********" keeps the STORED secret (never writes the placeholder)', async () => {
    await updateIntegration('int-1', 'co-A', { config: { site_url: 'https://a.example', secret: '********' } });
    expect(credentialWrites).toEqual([{ secret: 'whsec_REAL' }]);
  });

  it('CONTROL: a real new secret is written as sent (the guard only touches the placeholder)', async () => {
    await updateIntegration('int-1', 'co-A', { config: { site_url: 'https://a.example', secret: 'whsec_NEW' } });
    expect(credentialWrites).toEqual([{ secret: 'whsec_NEW' }]);
  });
});
