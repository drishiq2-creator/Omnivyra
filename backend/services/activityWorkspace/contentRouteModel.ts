/** Part 1/2 of content.ts — verbatim split (barrel preserved; importers unchanged). */
import { NextApiRequest, NextApiResponse } from 'next';
import {
  buildPlatformVariantsFromMaster,
  generateMasterContentFromIntent,
  optimizeDiscoverabilityForPlatform,
  type MasterContentPayload,
} from '@/backend/services/contentGenerationPipeline';
import { runCompletionWithOperation } from '@/backend/services/aiGateway';
import { processContent } from '@/backend/services/unifiedContentProcessor';
import { supabase } from '@/backend/db/supabaseClient';
import { getCreditCost, type CreditAction } from '@/backend/services/creditDeductionService';
import { executeWithCredits, executeWithEntryConsumption, makeIdempotencyKey } from '@/backend/services/creditExecutionService';
import { getCreditEconomyExecutionMode } from '@/backend/services/billing/creditEconomyActivation';
import { assertOrgMembership } from '@/backend/services/requestAccessService';
import { generateMasterContentStrict } from '@/backend/services/contentGeneration/blueprintGenerator';
import { getContentTypeCategory } from '@/backend/services/contentGeneration/contentTypeHelpers';
// Closure Pass — Phase 4. Activity workspace generation paths attach
// governance to the item before calling the pipeline.
import { enrichItemWithGovernance } from '@/backend/services/creator/governanceItemEnricher';
// Phase-2 Step-3: master/variant enrichment persistence routes through the
// ONE canonical write (reconciled, blank/stale-overwrite-safe, observable).
import { updateExecutionContentByActivity } from '@/backend/services/orchestration';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { resolveMonetizationFeature } from '@/shared/monetization/featureRegistry';
import { createHash } from 'crypto';
import {
  BilledResultUnpersistedError, BilledRouteKeyRequiredError, BilledRouteRequestEndedError,
  clientIdempotencyKey, persistBilledResultOrThrow, replayOrRefund,
} from '@/backend/services/billing/billedRequestRecovery';

import { isFailedVariant } from './contentRouteHandler';

export type WorkspaceAction = 'generate_master' | 'generate_variants' | 'refine_variant' | 'improve_variant' | 'improve_variant_all';
export type ImprovementType = 'IMPROVE_CTA' | 'IMPROVE_HOOK' | 'ADD_DISCOVERABILITY';

export class MonetizedWorkflowError extends Error {
  statusCode: number;
  payload: Record<string, unknown>;

  constructor(statusCode: number, payload: Record<string, unknown>) {
    super(String(payload.error ?? 'Monetized workflow failed'));
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

export async function runReservedFixedWorkflow<T>(input: {
  userId: string;
  companyId: string | null;
  action: CreditAction;
  referenceId: string;
  referenceType: string;
  note: string;
  multiplier?: number;
  executor: () => Promise<T>;
  /**
   * b3 rulings 2026-11-18 (BLOCKING-launch) - opt in to billed-request recovery (billedRequestRecovery):
   *   - the identity is the client's Idempotency-Key (REQUIRED; never synthesised), scoped to referenceId;
   *   - the executor's result is persisted (billedResultStore, read back) INSIDE the charge, so it is never confirmed
   *     for a result that cannot be returned (not persisted -> released, the work is returned free);
   *   - a same-key retry replays it; a durably unreadable replay refunds the original charge (system-paid).
   */
  recovery?: { surface: string; scope: string; idempotencyKeyHeader: unknown; onReplay?: () => void };
}): Promise<T> {
  if (!input.companyId) {
    throw new MonetizedWorkflowError(400, { error: 'Company context is required for billable content actions' });
  }

  // referenceId may be a semantic string (e.g. "workspace-linkedin") for
  // transient workspace flows; executeWithCredits canonicalizes it into a
  // UUID at the boundary and preserves the original in note + telemetry.
  // The semantic key is kept verbatim in idempotencyKey so dedup behavior is
  // unaffected by the UUID projection.
  const registryResolution = resolveMonetizationFeature({ action_key: input.action });
  if (!registryResolution) {
    throw new MonetizedWorkflowError(500, { error: `No monetization registry entry for ${input.action}` });
  }
  // Recovery: identity = referenceId + the client's key (required); replay before any charge.
  let identity: string | null = null;
  let executor = input.executor;
  if (input.recovery) {
    const clientKey = clientIdempotencyKey(input.recovery.idempotencyKeyHeader);
    if (!clientKey) throw new BilledRouteKeyRequiredError(input.recovery.surface);
    identity = `${input.referenceId}:k:${createHash('sha256').update(clientKey).digest('hex').slice(0, 24)}`;
    const recovery = input.recovery;
    const orgId = input.companyId;
    const replay = await replayOrRefund({
      surface: recovery.surface, scope: recovery.scope, orgId, key: identity, performedBy: input.userId,
      confirmKeys: [`${makeIdempotencyKey(input.userId, input.action, identity, input.note)}:confirm`], referenceId: input.referenceId,
    });
    if (replay) { recovery.onReplay?.(); return replay.value as T; }
    const run = input.executor;
    const key = identity;
    executor = async () => {
      const value = await run();
      await persistBilledResultOrThrow({ scope: recovery.scope, orgId, key, value });   // throws -> released
      return value;
    };
  }
  const baseCost = await getCreditCost(input.action);
  const amountOverride = Math.round(baseCost * (input.multiplier ?? 1));
  let result;
  try {
    result = await executeWithCredits<T>({
      userId: input.userId,
      orgId: input.companyId,
      action: input.action,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      idempotencyKey: makeIdempotencyKey(input.userId, input.action, identity ?? input.referenceId, input.note),
      amountOverride,
      note: `${input.note} [feature=${registryResolution.feature_key}; pricing=${registryResolution.pricing_key}]`,
      executor,
    });
  } catch (err) {
    // Delivered in this response but not durably stored: released, NOT charged (the work is still returned).
    if (err instanceof BilledResultUnpersistedError) return err.result as T;
    throw err;
  }

  if (result.status === 'executed') return result.result;
  if (identity && result.status === 'already_released') throw new BilledRouteRequestEndedError(input.recovery!.surface);
  if (result.status === 'insufficient_credits') {
    throw new MonetizedWorkflowError(402, {
      error: 'Insufficient credits to generate content',
      required: result.required,
      balance: result.available,
    });
  }
  if (result.status === 'not_a_member') throw new MonetizedWorkflowError(403, { error: 'ORG_SCOPE_VIOLATION' });
  if (result.status === 'org_control_blocked') throw new MonetizedWorkflowError(403, { error: result.code, detail: result.reason });
  if (result.status === 'no_credit_account') throw new MonetizedWorkflowError(402, { error: 'No credit account for org' });
  throw new MonetizedWorkflowError(409, { error: `Credit reservation is already settled: ${result.status}` });
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 3AH-92 (S-2) — a row the handler resolved server-side AND bound to the
 * authorized tenant. Persistence accepts nothing else: a caller-supplied id can
 * no longer reach the write, and the write is pinned to the row's campaign.
 */
export type ContentWriteTarget = { rowId: string; campaignId: string };

async function persistContentEnvelopeToDb(
  target: ContentWriteTarget | null,
  transform: (existing: Record<string, unknown>) => Record<string, unknown>,
  opts: { strict?: boolean } = {},
): Promise<void> {
  if (!target) return; // transient / unresolved activity — nothing to persist (billed paths store via billedResultStore)
  // Canonical write: locates the row, applies the transform, reconciles
  // (enrichment-priority merge, blank/stale-overwrite guards, log-only
  // invariants), preserves legacy row shape, and emits write observability.
  const r = await updateExecutionContentByActivity(target.rowId, transform, 'activity-workspace/content', { campaignId: target.campaignId });
  // c6 2026-11-18 (b3): the write reports failure as { ok: false } - a BILLED path must not swallow it (strict): the
  // throw inside the executor releases the charge.
  if (opts.strict && (!r || (r as { ok?: boolean }).ok === false)) {
    throw new Error(`content write failed: ${String((r as { reason?: string } | undefined)?.reason ?? 'unknown')}`);
  }
}

/** Merge master_content into daily_content_plans.content JSON blob for the given activity row. */
export async function persistMasterToDb(target: ContentWriteTarget | null, master: MasterContentPayload, opts: { strict?: boolean } = {}): Promise<void> {
  await persistContentEnvelopeToDb(target, (existing) => ({ ...existing, master_content: master }), opts);
}

export async function persistVariantsToDb(
  target: ContentWriteTarget | null,
  variants: Array<Record<string, unknown>>,
  master: Record<string, unknown> | null | undefined,
  opts: { strict?: boolean } = {},
): Promise<void> {
  await persistContentEnvelopeToDb(target, (existing) => {
    const previous = Array.isArray(existing.platform_variants) ? (existing.platform_variants as Array<Record<string, unknown>>) : [];
    const merged = new Map<string, Record<string, unknown>>();

    for (const variant of previous) {
      const key = `${String((variant as any)?.platform || '').trim().toLowerCase()}::${String((variant as any)?.content_type || '').trim().toLowerCase()}`;
      if (key !== '::') merged.set(key, variant);
    }
    for (const variant of variants) {
      const key = `${String((variant as any)?.platform || '').trim().toLowerCase()}::${String((variant as any)?.content_type || '').trim().toLowerCase()}`;
      if (key !== '::') merged.set(key, variant);
    }

    const variantList = Array.from(merged.values());
    const primaryGenerated = variantList.find((variant) => {
      const content = String((variant as any)?.generated_content || '').trim();
      return content.length > 0 && !isFailedVariant(variant);
    });

    return {
      ...existing,
      ...(master ? { master_content: master } : {}),
      platform_variants: variantList,
      ...(primaryGenerated ? { generated_content: String((primaryGenerated as any).generated_content || '').trim() } : {}),
      content_status: variantList.length > 0 ? 'repurposed' : existing.content_status,
      repurposed_at: variantList.length > 0 ? new Date().toISOString() : existing.repurposed_at,
    };
  }, opts);
}

export const FAILED_VARIANT_PREFIXES = [
  '[PLATFORM ADAPTATION FAILED]',
  '[MASTER GENERATION FAILED',
];
// Note: [PLATFORM MEDIA BLUEPRINT] is NOT a failure — it is a valid creator-activity placeholder
// indicating the variant requires a media asset. It is returned as a successful variant so the
// client can show a "waiting for media" state rather than an error.

