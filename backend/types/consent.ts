import type {
  CapabilitySource,
  IntegrationCapability,
} from './integrationCapabilities';
import { INTEGRATION_CAPABILITIES } from './integrationCapabilities';

/**
 * EVERY value consent_records.capability may hold - the database's consent_records_capability_check, EXACTLY
 * (parity-tested against the latest migration that defines it: consentCapabilityParity.test.ts).
 *
 * It is deliberately NOT INTEGRATION_CAPABILITIES: that list is also the INPUT allowlist of the integration
 * capability routes (isIntegrationCapability, pages/api/active-leads/capabilities.ts), and an acknowledgement is not
 * an integration capability a client may set there - widening it would let a client write an acknowledgement row
 * without the acknowledgement's own text-version checks (c6/7c, 2026-11-21). The acknowledgements are consent-ledger
 * values written only by their own services.
 */
export const CONSENT_ACK_CAPABILITIES = ['tenant_data_controller_ack', 'salesnav_linkedin_restriction_ack'] as const;
export const CONSENT_CAPABILITIES = [...INTEGRATION_CAPABILITIES, ...CONSENT_ACK_CAPABILITIES] as const;
export type ConsentCapability = IntegrationCapability | (typeof CONSENT_ACK_CAPABILITIES)[number];

export const CONSENT_VERSION_V1 = 'consent_v1' as const;
export type ConsentVersion = typeof CONSENT_VERSION_V1 | string;

export type ConsentRecord = {
  id: string;
  organization_id: string;
  integration_id: string | null;
  platform: string;
  capability: ConsentCapability;
  consent_version: ConsentVersion;
  granted_by: string | null;
  granted_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  scope_snapshot: string[];
  metadata: Record<string, unknown>;
  source: CapabilitySource;
  created_at: string;
  updated_at: string;
};
