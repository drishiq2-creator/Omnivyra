/**
 * Round 26 / T-12 — an unusable BYOK key surfaces a tenant-facing status.
 *
 * `getCompanyLlmConfig` feeds GET /api/company/llm-config (the tenant's AI settings). It now
 * reports `byok_status` ('not_configured' | 'active' | 'unusable') with a reason code, so a
 * corrupt or empty stored key is visible instead of silently running on the platform key.
 * State + reason only: never the key, a fragment or a length (policy P4/P5).
 *
 * FAILING CONTROL: at origin/main 2bc52db7a `byok_status` is absent (undefined) for the
 * corrupt-ciphertext row — the only signal was a server console.warn.
 */
import { encryptCredential } from '../../auth/credentialEncryption';

let mockRow: Record<string, unknown> | null = null;
jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: () => {
    const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: mockRow, error: null }) };
    return q;
  },
}));
jest.mock('../../db/supabaseClient', () => ({ supabase: {} }));

import { getCompanyLlmConfig, classifyStoredByokKey } from '../../services/llmProviderService';

const TENANT_KEY = 'sk-FAKE-tenant-byok-r26-abcdef';
const base = (api_key_encrypted: string | null) => ({
  id: 'cfg', company_id: 'company-a', provider_id: 'p', model_id: 'm', api_key_encrypted, is_active: true,
  updated_by: null, created_at: '', updated_at: '',
  llm_providers: { name: 'openai', display_name: 'OpenAI' }, llm_models: { model_key: 'gpt-4o', display_name: 'GPT-4o', metadata: {} },
});

describe('T-12: BYOK status is tenant-visible', () => {
  it('corrupt ciphertext → byok_status "unusable" (decrypt_failed), no key material in the response', async () => {
    mockRow = base('00112233445566778899aabb:00112233445566778899aabbccddeeff:deadbeef');
    const cfg = await getCompanyLlmConfig('company-a');
    expect(cfg?.has_custom_api_key).toBe(true); // scenario: a key IS stored
    expect(cfg?.byok_status).toBe('unusable');
    expect(cfg?.byok_status_reason).toBe('decrypt_failed');
    expect(JSON.stringify(cfg)).not.toContain('deadbeef');
  });

  it('a valid stored key → "active"; the decrypted key never appears in the response', async () => {
    mockRow = base(encryptCredential(TENANT_KEY));
    const cfg = await getCompanyLlmConfig('company-a');
    expect(cfg?.byok_status).toBe('active');
    expect(cfg?.byok_status_reason).toBeNull();
    expect(JSON.stringify(cfg)).not.toContain(TENANT_KEY);
  });

  it('no stored key → "not_configured" (platform key by design, not an error)', async () => {
    mockRow = base(null);
    const cfg = await getCompanyLlmConfig('company-a');
    expect(cfg?.byok_status).toBe('not_configured');
  });

  it('classifyStoredByokKey reports decrypt failure and absence with distinct states', () => {
    expect(classifyStoredByokKey('not-a-ciphertext')).toEqual({ status: 'unusable', reason: 'decrypt_failed' });
    expect(classifyStoredByokKey(undefined)).toEqual({ status: 'not_configured', reason: null });
  });
});
