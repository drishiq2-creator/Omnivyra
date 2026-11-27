import { ownedDbTable } from '../db/writeOwner';
/**
 * Engagement Governance Service
 * Get and update engagement system controls per organization.
 */

import { supabase } from '../db/supabaseClient';

export type EngagementControls = {
  auto_reply_enabled: boolean;
  bulk_reply_enabled: boolean;
  ai_suggestions_enabled: boolean;
  triage_engine_enabled: boolean;
  opportunity_detection_enabled: boolean;
  response_strategy_learning_enabled: boolean;
  digest_generation_enabled: boolean;
};

const DEFAULTS: EngagementControls = {
  auto_reply_enabled: true,
  bulk_reply_enabled: true,
  ai_suggestions_enabled: true,
  triage_engine_enabled: true,
  opportunity_detection_enabled: true,
  response_strategy_learning_enabled: true,
  digest_generation_enabled: true,
};

export async function getControls(organizationId: string): Promise<EngagementControls> {
  if (!organizationId) return DEFAULTS;

  const { data, error } = await ownedDbTable('engagement_system_controls')
    .select('*')
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error || !data) return DEFAULTS;

  return {
    auto_reply_enabled: data.auto_reply_enabled ?? true,
    bulk_reply_enabled: data.bulk_reply_enabled ?? true,
    ai_suggestions_enabled: data.ai_suggestions_enabled ?? true,
    triage_engine_enabled: data.triage_engine_enabled ?? true,
    opportunity_detection_enabled: data.opportunity_detection_enabled ?? true,
    response_strategy_learning_enabled: data.response_strategy_learning_enabled ?? true,
    digest_generation_enabled: data.digest_generation_enabled ?? true,
  };
}

export async function updateControls(
  organizationId: string,
  controls: Partial<EngagementControls>
): Promise<EngagementControls> {
  if (!organizationId) return DEFAULTS;

  const now = new Date().toISOString();
  const payload: Record<string, unknown> = {
    organization_id: organizationId,
    updated_at: now,
  };
  if (typeof controls.auto_reply_enabled === 'boolean') payload.auto_reply_enabled = controls.auto_reply_enabled;
  if (typeof controls.bulk_reply_enabled === 'boolean') payload.bulk_reply_enabled = controls.bulk_reply_enabled;
  if (typeof controls.ai_suggestions_enabled === 'boolean') payload.ai_suggestions_enabled = controls.ai_suggestions_enabled;
  if (typeof controls.triage_engine_enabled === 'boolean') payload.triage_engine_enabled = controls.triage_engine_enabled;
  if (typeof controls.opportunity_detection_enabled === 'boolean') payload.opportunity_detection_enabled = controls.opportunity_detection_enabled;
  if (typeof controls.response_strategy_learning_enabled === 'boolean') payload.response_strategy_learning_enabled = controls.response_strategy_learning_enabled;
  if (typeof controls.digest_generation_enabled === 'boolean') payload.digest_generation_enabled = controls.digest_generation_enabled;

  const { data, error } = await ownedDbTable('engagement_system_controls')
    .upsert(payload, { onConflict: 'organization_id' })
    .select()
    .single();

  if (error) {
    console.warn('[engagementGovernance] updateControls error', error.message);
    return getControls(organizationId);
  }

  return {
    auto_reply_enabled: data?.auto_reply_enabled ?? true,
    bulk_reply_enabled: data?.bulk_reply_enabled ?? true,
    ai_suggestions_enabled: data?.ai_suggestions_enabled ?? true,
    triage_engine_enabled: data?.triage_engine_enabled ?? true,
    opportunity_detection_enabled: data?.opportunity_detection_enabled ?? true,
    response_strategy_learning_enabled: data?.response_strategy_learning_enabled ?? true,
    digest_generation_enabled: data?.digest_generation_enabled ?? true,
  };
}

/**
 * Raised by readBulkReplyEnabled when the bulk-reply policy cannot be read.
 * Carries the organization id and the underlying message only — never the raw
 * database error object.
 */
export class EngagementControlsUnreadableError extends Error {
  readonly organizationId: string;
  readonly causeMessage: string | null;

  constructor(organizationId: string, causeMessage: string | null) {
    super(
      `Engagement controls could not be read for organization ${organizationId || '(none)'}` +
        (causeMessage ? `: ${causeMessage}` : ''),
    );
    this.name = 'EngagementControlsUnreadableError';
    this.organizationId = organizationId;
    this.causeMessage = causeMessage;
  }
}

/**
 * Strict reader for the tenant's bulk-reply switch, used by the bulk-reply
 * routes. Owner decision F-FU1 (2026-11-27): the shared bulk-reply policy
 * fails CLOSED when the database read fails — a read error is never read as
 * "enabled"; it throws EngagementControlsUnreadableError instead.
 *
 * - no organization id        -> throws EngagementControlsUnreadableError
 * - read error                -> throws EngagementControlsUnreadableError
 * - no row, PROVEN            -> true (product default, pending a separate
 *                                product-policy decision)
 * - ambiguous response        -> throws EngagementControlsUnreadableError
 * - row                       -> same semantics as getControls
 *                                (`bulk_reply_enabled ?? true`); a non-boolean
 *                                value throws
 *
 * "No row" must be PROVEN, not inferred from `!error && !data`.
 * @supabase/postgrest-js (2.105.3, processResponse) rewrites two non-answers
 * into error-free responses on its !res.ok path, which maybeSingle() never
 * touches:
 *   - a 404 with an EMPTY body (edge, WAF, paused project) becomes
 *     { status: 204, data: null, error: null };
 *   - a 404 with a JSON-array body becomes { status: 200, data: [], error: null }.
 * And a 200 with an empty body (an intermediary, not PostgREST) also yields
 * { status: 200, data: null }. Only PostgREST's own answer to a counted GET
 * carries Content-Range, so `count === 0` is the positive proof that the
 * database answered "no row". Anything else without a usable row fails closed.
 *
 * getControls() is intentionally unchanged: its other consumers keep their
 * existing behaviour.
 */
export async function readBulkReplyEnabled(organizationId: string): Promise<boolean> {
  if (!organizationId) {
    throw new EngagementControlsUnreadableError(organizationId, 'organization id required');
  }

  const { data, error, status, count } = (await ownedDbTable('engagement_system_controls')
    .select('bulk_reply_enabled', { count: 'exact' })
    .eq('organization_id', organizationId)
    .maybeSingle()) as {
    data: unknown;
    error: unknown;
    status?: number;
    count?: number | null;
  };

  if (error) {
    const message =
      typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : null;
    throw new EngagementControlsUnreadableError(organizationId, message);
  }

  // Only a 200 is an answer. 204 is the client's rewrite of a blank 404.
  if (status !== 200) {
    throw new EngagementControlsUnreadableError(
      organizationId,
      `ambiguous policy response (status ${status ?? 'missing'})`,
    );
  }

  if (data === null || data === undefined) {
    if (count === 0) return true; // PostgREST counted zero rows: genuinely absent.
    throw new EngagementControlsUnreadableError(
      organizationId,
      `ambiguous empty policy response (count ${count ?? 'missing'})`,
    );
  }

  // maybeSingle() only unwraps arrays on the res.ok path; an array here is the
  // client's rewrite of a 404, not a row.
  if (Array.isArray(data) || typeof data !== 'object') {
    throw new EngagementControlsUnreadableError(organizationId, 'ambiguous policy response shape');
  }

  const value = (data as { bulk_reply_enabled?: unknown }).bulk_reply_enabled;
  if (value === null || value === undefined) return true; // same as getControls' `?? true`
  if (typeof value !== 'boolean') {
    throw new EngagementControlsUnreadableError(organizationId, 'malformed bulk_reply_enabled value');
  }
  return value;
}
