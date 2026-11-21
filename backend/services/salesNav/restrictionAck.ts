/**
 * The Sales Navigator LINKEDIN-RESTRICTION ACKNOWLEDGEMENT (b3 ruling 1, 2026-11-21; migration 075).
 *
 * Stored in the append-only consent ledger (consent_records), one row per acknowledgement:
 *   capability 'salesnav_linkedin_restriction_ack', platform 'salesnav:<transport>', consent_version = text version,
 *   granted_by = the user, granted_at = the time, organization_id = the company, metadata = { text_sha256, wording_status }.
 * The gate reads the LATEST unrevoked acknowledgement per (company, transport) and requires it to be for the CURRENT
 * text version (a new version = a re-ack). An unreadable ledger is NEVER "no ack needed": the gate fails closed.
 *
 * THE TEXT IS A PLACEHOLDER until counsel (wording_status 'placeholder'; register). Changing the wording means a new
 * version here, which re-asks every company.
 */
import { createHash } from 'crypto';
import { ownedDbTable } from '../../db/writeOwner';
import { recordConsent } from '../consentLedgerService';
import type { SalesNavCallerContext, SalesNavTransport } from './contract';

export const SALESNAV_ACK_CAPABILITY = 'salesnav_linkedin_restriction_ack' as const;
export const salesNavAckPlatform = (transport: SalesNavTransport): string => `salesnav:${transport}`;

const TEXT = [
  'PLACEHOLDER - pending legal review. Reading Sales Navigator through any automated route uses YOUR OWN LinkedIn',
  'account. LinkedIn may restrict or suspend accounts it believes are automated. Omnivyra limits reading to your',
  'daily cap, but cannot guarantee LinkedIn will not act on your account. You confirm you have the right to use this',
  'account for this purpose and accept this risk for your company.',
].join(' ');

export const SALESNAV_RESTRICTION_ACK = {
  version: 'placeholder-v0',
  status: 'placeholder' as const,
  text: TEXT,
  textSha256: createHash('sha256').update(TEXT, 'utf8').digest('hex'),
};

export interface AckRow {
  readonly consent_version: string;
  readonly granted_by: string | null;
  readonly granted_at: string;
}

/** The latest unrevoked acknowledgement for (company, transport): the row, null when there is none, or 'unreadable'. */
export async function readLatestSalesNavAck(
  organizationId: string, transport: SalesNavTransport,
  deps: { table?: (name: string) => any } = {},
): Promise<AckRow | null | 'unreadable'> {
  try {
    const res = await (deps.table ?? ownedDbTable)('consent_records')
      .select('consent_version, granted_by, granted_at')
      .eq('organization_id', organizationId)
      .eq('platform', salesNavAckPlatform(transport))
      .eq('capability', SALESNAV_ACK_CAPABILITY)
      .is('revoked_at', null)
      .order('granted_at', { ascending: false })
      .limit(1);
    const { data, error, status } = res as { data: unknown; error: unknown; status?: number };
    if (error || (status !== 200 && status !== 206) || !Array.isArray(data)) return 'unreadable';
    return (data[0] as AckRow | undefined) ?? null;
  } catch {
    return 'unreadable';
  }
}

/** Does the latest acknowledgement cover the CURRENT text? */
export function ackCoversCurrentText(latest: AckRow | null): boolean {
  return !!latest && latest.consent_version === SALESNAV_RESTRICTION_ACK.version;
}

export class SalesNavAckRefused extends Error {
  constructor(readonly code: 'stale_text' | 'no_user' | 'write_failed') { super(`salesnav_ack:${code}`); }
}

/**
 * Record the user's acknowledgement of the text they were SHOWN. The shown version and text hash must be the
 * current ones (verified here, server-side): an acknowledgement of a text we no longer show is refused.
 */
export async function recordSalesNavAck(
  ctx: SalesNavCallerContext,
  input: { transport: SalesNavTransport; shownVersion: string; shownTextSha256: string },
  deps: { record?: typeof recordConsent; now?: () => Date } = {},
): Promise<{ acceptedVersion: string }> {
  if (!ctx.initiatedBy) throw new SalesNavAckRefused('no_user');
  if (input.shownVersion !== SALESNAV_RESTRICTION_ACK.version || input.shownTextSha256 !== SALESNAV_RESTRICTION_ACK.textSha256) {
    throw new SalesNavAckRefused('stale_text');
  }
  try {
    await (deps.record ?? recordConsent)({
      organizationId: ctx.organizationId,
      platform: salesNavAckPlatform(input.transport),
      capability: SALESNAV_ACK_CAPABILITY,
      grantedBy: ctx.initiatedBy,
      grantedAt: (deps.now ?? (() => new Date()))().toISOString(),
      // RecordConsentInput requires a scope (CI-839 TS2345): what was acknowledged - the transport's restriction
      scopeSnapshot: [input.transport],
      source: 'ui',
      consentVersion: SALESNAV_RESTRICTION_ACK.version,
      metadata: { text_sha256: SALESNAV_RESTRICTION_ACK.textSha256, wording_status: SALESNAV_RESTRICTION_ACK.status },
    });
  } catch {
    throw new SalesNavAckRefused('write_failed');
  }
  return { acceptedVersion: SALESNAV_RESTRICTION_ACK.version };
}
