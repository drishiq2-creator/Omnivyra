/**
 * PL-180 (c6's find; 04, 2026-11-21): a tenant credential-store READ FAILURE is not "the tenant has no key".
 *
 * makeTenantCredentialPort().resolveCredential answered a store failure with the same null as "no key". The executor
 * is right to treat both as "no call" (fail closed, unchanged here). But the Apollo enrich PREVIEW reported that null
 * as funding 'no_apollo_access', telling the tenant to add a key they may already have. Now the port has a
 * three-state answer and the preview answers an unreadable store with 503, which the client renders as
 * "could not be prepared. Nothing was spent." (ApolloEnrichBar).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { makeTenantCredentialPort } from '../../services/enrichment/providers/credentials';

describe('the credential port: three states, and resolveCredential unchanged', () => {
  const port = (read: () => Promise<Record<string, string>>) => makeTenantCredentialPort({ read });

  it('a store read that THROWS is unreadable, and resolveCredential still answers null (executor: no call)', async () => {
    const p = port(async () => { throw new Error('decrypt failed'); });
    expect(await p.resolveCredentialState({ organizationId: 'o', providerId: 'apollo' })).toEqual({ kind: 'unreadable' });
    expect(await p.resolveCredential({ organizationId: 'o', providerId: 'apollo' })).toBeNull();
  });
  it('CONTROL: no stored key is absent (and null)', async () => {
    const p = port(async () => ({}));
    expect(await p.resolveCredentialState({ organizationId: 'o', providerId: 'apollo' })).toEqual({ kind: 'absent' });
    expect(await p.resolveCredential({ organizationId: 'o', providerId: 'apollo' })).toBeNull();
  });
  it('CONTROL: a blank stored key is absent, not present', async () => {
    const p = port(async () => ({ api_key: '   ' }));
    expect(await p.resolveCredentialState({ organizationId: 'o', providerId: 'apollo' })).toEqual({ kind: 'absent' });
  });
  it('CONTROL: a stored key is present (and returned)', async () => {
    const p = port(async () => ({ api_key: 'k-1' }));
    expect(await p.resolveCredentialState({ organizationId: 'o', providerId: 'apollo' })).toEqual({ kind: 'present', value: 'k-1' });
    expect(await p.resolveCredential({ organizationId: 'o', providerId: 'apollo' })).toBe('k-1');
  });
  it('a tenant-less lookup never reaches the store (absent, no read)', async () => {
    const read = jest.fn(async () => ({ api_key: 'k' }));
    const p = makeTenantCredentialPort({ read });
    expect(await p.resolveCredentialState({ organizationId: '  ', providerId: 'apollo' })).toEqual({ kind: 'absent' });
    expect(read).not.toHaveBeenCalled();
  });
  it('resolveCredential works as an UNBOUND reference (productionPorts passes it that way)', async () => {
    const { resolveCredential } = port(async () => ({ api_key: 'k-2' }));
    expect(await resolveCredential({ organizationId: 'o', providerId: 'apollo' })).toBe('k-2');
  });
});

// ── the preview route ────────────────────────────────────────────────────────
let mockKey: { kind: 'present'; value: string } | { kind: 'absent' } | { kind: 'unreadable' } = { kind: 'absent' };
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../security/TenantGuard', () => ({ requireTenantAccess: async () => ({ userId: 'u1' }) }));
jest.mock('../../security/requireCapability', () => ({ requireCapability: async () => ({ ok: true }) }));
jest.mock('../../services/compliance/tenantDataAck', () => ({
  getTenantDataAckStatus: async () => ({ categories: { vendor_data: { state: 'current', allowed: true }, contact_data: { state: 'current', allowed: true } } }),
  requireCategoryAck: () => undefined,
  TenantDataAckRequired: class extends Error {},
  TenantDataAckUnreadable: class extends Error {},
}));
jest.mock('../../apiHandlers/prospects/prospectIntelligenceRead', () => ({
  previewProspectEnrichmentBatch: async () => ({ calls: [], estimatedProviderCalls: 0, estimateHash: 'h' }),
  executeProspectEnrichmentBatch: jest.fn(),
  MAX_ENRICHMENT_BATCH_PROSPECTS: 25,
  MAX_ENRICHMENT_BATCH_PROVIDER_CALLS: 50,
}));
jest.mock('../../services/enrichment/apolloFieldGroups', () => ({
  readTenantFieldGroups: async () => [],
  allowedAttributesFor: () => [],
}));
jest.mock('../../services/enrichment/providers/vendorUnits', () => ({ unitsForCall: () => ({ units: 1 }) }));
jest.mock('../../services/enrichment/providers/credentials', () => {
  const actual = jest.requireActual('../../services/enrichment/providers/credentials');
  return {
    ...actual,
    tenantCredentialPort: {
      resolveCredentialState: async () => mockKey,
      resolveCredential: async () => (mockKey.kind === 'present' ? mockKey.value : null),
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const handler = require('../../../pages/api/prospect-sources/apollo-enrich').default;
async function preview() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = () => res;
  await handler({ method: 'POST', query: { companyId: 'co-A' }, body: { mode: 'preview', prospectIds: ['p1'], maxProviderCalls: 5 } } as unknown as NextApiRequest, res as NextApiResponse);
  return res;
}

describe('POST /api/prospect-sources/apollo-enrich preview', () => {
  it('an UNREADABLE credential store is 503 CREDENTIAL_STORE_UNREADABLE, never funding no_apollo_access', async () => {
    mockKey = { kind: 'unreadable' };
    const res = await preview();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'CREDENTIAL_STORE_UNREADABLE', code: 'CREDENTIAL_STORE_UNREADABLE' });
    expect(JSON.stringify(res.body)).not.toMatch(/no_apollo_access/);
  });
  it('CONTROL: no key → 200 funding no_apollo_access (a genuine absence is still said)', async () => {
    mockKey = { kind: 'absent' };
    const res = await preview();
    expect(res.statusCode).toBe(200);
    expect(res.body.funding).toBe('no_apollo_access');
  });
  it('CONTROL: own key → 200 funding tenant_apollo_key, and the key VALUE never leaves the server', async () => {
    mockKey = { kind: 'present', value: 'SECRET-APOLLO-KEY' };
    const res = await preview();
    expect(res.statusCode).toBe(200);
    expect(res.body.funding).toBe('tenant_apollo_key');
    expect(JSON.stringify(res.body)).not.toContain('SECRET-APOLLO-KEY');
  });
});
