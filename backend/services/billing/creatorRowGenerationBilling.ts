/**
 * C75 (e1 2026-11-13) - the creator scheduler's per-row AI generation as ONE billed unit.
 *
 * structuredPlanSchedulerExecWeeklyA runs engine.generateFromIntent (blueprint - up to 3 calls for a carousel - plus
 * marketing packaging) for every creator daily-plan row. That AI ran unbilled. This helper bills it token-actual
 * through executeWithEntryConsumption (owner rule: hold the maximum, settle actual x 15).
 *
 * DOUBLY DARK: billed only when getCreditEconomyExecutionMode() is 'enforce' (master entry-consumption switch AND the
 * per-org enforcement gate). Any other mode runs generate() exactly as before - no ledger read, no stash.
 *
 * Identity: one per campaign / row / plan version (a new plan version is new content and a new charge). A failed
 * attempt RELEASES its exposure, so the same identity answers already_released and the next slot `:r<n>` is used
 * (the shared reclaim semantics).
 *
 * PERSIST BEFORE SETTLE (c6 2026-11-20 re-land; b3 rule): the charged output is written to the row (STASH_KEY, via the
 * caller's persistStash, which THROWS on a failed write) INSIDE the executor - before the engine confirms. A failed
 * stash write throws inside the charge, so the hold is RELEASED (our failure is free) and the next slot is used. Any
 * later attempt or run reuses the stash: never re-run, never re-charged.
 * already_settled with no usable stash can then only be a charge taken BEFORE this change: the original charge is
 * REFUNDED in full (owedRefunds, idempotent per original confirm) and the row is generated on the next slot - charged
 * once for output that exists. If the refund cannot even be recorded the row is refused retryably, promising nothing.
 * (The former "charged-no-output -> critical anomaly, operator decides" path is gone.)
 */
import { executeWithEntryConsumption, getReservationKeys, makeIdempotencyKey } from '../creditExecutionService';
import { readOriginalCharge, refundOriginalCharge } from './owedRefunds';
import { getCreditEconomyExecutionMode } from './creditEconomyActivation';
import { emitAnomaly } from './billingAuditEmitter';
import { logger } from '../logger';

export const CREATOR_ROW_SURFACE = 'scheduler.creator-row';
/** Same action as the queued creator-content processor bills for the same engine work (LONG_GENERATION). */
export const CREATOR_ROW_ACTION = 'content_generation';
export const CREATOR_ROW_REFERENCE_TYPE = 'creator_daily_plan_row';
/** Shared reclaim cap (backend/tests/helpers/reclaimSemanticsCases.ts RECLAIM_CAP). */
export const MAX_CREATOR_ROW_RECLAIM_ATTEMPTS = 20;
/** Row-content key holding a charged generation for reuse. Never passed back into a prompt. */
export const STASH_KEY = 'billed_generation';
/** Calls in one unit: a carousel blueprint (1 + MAX_CAROUSEL_COMPLETION_RETRIES=2) + packaging. */
export const CREATOR_ROW_UNIT_CALLS = 4;

export type CreatorRowBillingCode =
  | 'INSUFFICIENT_CREDITS' | 'NO_CREDIT_ACCOUNT' | 'ORG_CONTROL_BLOCKED' | 'NOT_A_MEMBER'
  | 'RECLAIM_CAP_EXHAUSTED' | 'CHARGE_UNVERIFIABLE' | 'REFUND_PENDING' | 'REFUND_NEEDS_REVIEW';

/**
 * The row's stash write did not land. Thrown by the caller's persistStash INSIDE the charge (the hold is released, so
 * nothing is charged); a database failure, so the attempt is TRANSIENT - the retry generates on the next slot.
 */
export class CreatorRowStashWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreatorRowStashWriteError';
  }
}

/** A billing refusal for one row. `retryable`: a later run can succeed without operator action. */
export class CreatorRowBillingRefusedError extends Error {
  constructor(
    public readonly code: CreatorRowBillingCode,
    public readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'CreatorRowBillingRefusedError';
  }
}

export interface CreatorRowStash {
  plan_version: number;
  reference_id: string;
  output: Record<string, unknown>;
}

export function creatorRowIdentity(campaignId: string, rowId: string, planVersion: number): string {
  return `creator_row:${campaignId}:${rowId}:v${planVersion}`;
}

/** A stash is reusable only for the SAME plan version and with an object output. */
export function readCreatorRowStash(raw: unknown, planVersion: number): CreatorRowStash | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<CreatorRowStash>;
  if (s.plan_version !== planVersion) return null;
  if (!s.output || typeof s.output !== 'object') return null;
  if (typeof s.reference_id !== 'string') return null;
  return s as CreatorRowStash;
}

export type CreatorRowGenerationResult<T> =
  | { billed: false; reused: false; output: T }                        // not enforced: today's path
  | { billed: true; reused: false; output: T }                         // charged now - the stash was persisted INSIDE the charge
  | { billed: true; reused: true; output: T };                         // already charged - reused, no AI, no charge

export async function generateCreatorRowBilled<T extends object>(args: {
  /** null = a campaign with no company: no wallet to charge -> refused when enforced (never free AI) */
  companyId: string | null;
  userId?: string | null;
  campaignId: string;
  rowId: string;
  planVersion: number;
  /** the row's STASH_KEY value (or an in-run stash), if any */
  stash: unknown;
  generate: () => Promise<T>;
  /**
   * Writes the stash to the row. MUST THROW when the write did not land (read the update's { error }): it runs INSIDE
   * the charge, before the confirm, so a throw releases the hold instead of charging for output that was not saved.
   */
  persistStash: (stash: CreatorRowStash) => Promise<void>;
}): Promise<CreatorRowGenerationResult<T>> {
  const mode = await getCreditEconomyExecutionMode({ organizationId: args.companyId, surface: CREATOR_ROW_SURFACE });
  if (mode !== 'enforce') return { billed: false, reused: false, output: await args.generate() };
  if (!args.companyId) {
    throw new CreatorRowBillingRefusedError('NO_CREDIT_ACCOUNT', false, 'creator row billing refused: NO_CREDIT_ACCOUNT (the campaign has no company)');
  }
  const companyId = args.companyId;

  const reusable = readCreatorRowStash(args.stash, args.planVersion);
  if (reusable) return { billed: true, reused: true, output: reusable.output as T };

  const identity = creatorRowIdentity(args.campaignId, args.rowId, args.planVersion);
  const ctx = { org: companyId, campaign: args.campaignId, row: args.rowId, plan_version: args.planVersion };
  for (let n = 0; n < MAX_CREATOR_ROW_RECLAIM_ATTEMPTS; n++) {
    const referenceId = n === 0 ? identity : `${identity}:r${n}`;
    const r = await executeWithEntryConsumption<T>({
      userId:              String(args.userId ?? companyId),
      orgId:               companyId,
      action:              CREATOR_ROW_ACTION,
      referenceType:       CREATOR_ROW_REFERENCE_TYPE,
      referenceId,
      idempotencyKey:      makeIdempotencyKey(companyId, CREATOR_ROW_ACTION, referenceId),
      validateMembership:  false,
      llmPricing: {
        provider: 'openai',
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        actionKey: CREATOR_ROW_ACTION,
        maxInputTokens: 8000 * CREATOR_ROW_UNIT_CALLS,
        maxOutputTokens: 2000 * CREATOR_ROW_UNIT_CALLS,
      },
      collectViaCollector: true,
      // Generate, then PERSIST the stash, both inside the charge: the engine confirms only after both succeeded.
      executor: async () => {
        const out = await args.generate();
        await args.persistStash({ plan_version: args.planVersion, reference_id: referenceId, output: out as unknown as Record<string, unknown> });
        return out;
      },
    });
    switch (r.status) {
      case 'executed':
        return { billed: true, reused: false, output: r.result as T };
      case 'already_released':
        continue; // that attempt failed uncharged - next slot
      case 'already_settled': {
        // Charged, but its output is not on the row: only possible for a charge taken BEFORE persist-inside-the-charge.
        // Refund it in full (our failure is free), then generate on the next slot.
        const confirmKey = getReservationKeys(makeIdempotencyKey(companyId, CREATOR_ROW_ACTION, referenceId)).confirmKey;
        let charge: Awaited<ReturnType<typeof readOriginalCharge>>;
        try {
          charge = await readOriginalCharge(confirmKey);
        } catch (err) {
          throw new CreatorRowBillingRefusedError('CHARGE_UNVERIFIABLE', true,
            `creator row billing refused: the earlier charge for ${referenceId} could not be read (${(err as Error)?.message}) - retry`);
        }
        if (charge) {
          const out = await refundOriginalCharge({
            orgId: companyId, performedBy: String(args.userId ?? companyId), charge,
            reason: 'creator_row_output_missing', grantKeyPrefix: 'creator_row_refund', referenceId,
          });
          if (out.status === 'unrecorded') {
            throw new CreatorRowBillingRefusedError('REFUND_PENDING', true,
              `creator row billing refused: the refund for ${referenceId} could not be recorded yet - retry`);
          }
          if (out.status === 'protected') {
            // The name promises a review: route it to the money surface, not only to the scheduler's failure audit
            // (7c 2026-11-20). The org holds a real un-refunded charge for an output it never received. emitAnomaly
            // logs it at error level with the metadata below.
            emitAnomaly({
              kind: 'refund_needs_review', severity: 'critical', organizationId: companyId,
              message: 'creator row: a pre-change charge with no output could not be refunded automatically (protected organisation) - review and refund',
              metadata: { ...ctx, surface: CREATOR_ROW_SURFACE, referenceId, confirmKey, confirmTxnId: charge.confirmTxnId },
            });
            throw new CreatorRowBillingRefusedError('REFUND_NEEDS_REVIEW', false,
              `creator row billing refused: ${referenceId} needs a reviewed refund (protected organisation)`);
          }
          logger.warn('creator_row_output_missing_refunded', { ...ctx, referenceId, refund: out.status });
        }
        continue; // refunded (or nothing was taken): generate on the next slot
      }
      case 'insufficient_credits':
        throw new CreatorRowBillingRefusedError('INSUFFICIENT_CREDITS', true,
          `creator row billing refused: INSUFFICIENT_CREDITS (required ${(r as any).required}, available ${(r as any).available})`);
      case 'no_credit_account':
        throw new CreatorRowBillingRefusedError('NO_CREDIT_ACCOUNT', false, 'creator row billing refused: NO_CREDIT_ACCOUNT');
      case 'org_control_blocked':
        throw new CreatorRowBillingRefusedError('ORG_CONTROL_BLOCKED', (r as any).code === 'DAILY_LIMIT_EXCEEDED',
          `creator row billing refused: ORG_CONTROL_BLOCKED (${(r as any).code})`);
      case 'not_a_member':
        throw new CreatorRowBillingRefusedError('NOT_A_MEMBER', false, 'creator row billing refused: NOT_A_MEMBER');
      default:
        throw new Error(`creator row billing: unexpected engine status ${(r as any).status}`);
    }
  }
  logger.error('creator_row_reclaim_cap_exhausted', { ...ctx, attempts: MAX_CREATOR_ROW_RECLAIM_ATTEMPTS });
  emitAnomaly({
    kind: 'reclaim_cap_exhausted', severity: 'critical', organizationId: companyId,
    message: 'creator row generation failed on every reclaim slot - nothing charged',
    metadata: { ...ctx, surface: CREATOR_ROW_SURFACE, attempts: MAX_CREATOR_ROW_RECLAIM_ATTEMPTS },
  });
  throw new CreatorRowBillingRefusedError('RECLAIM_CAP_EXHAUSTED', false,
    `creator row billing refused: RECLAIM_CAP_EXHAUSTED (${MAX_CREATOR_ROW_RECLAIM_ATTEMPTS} uncharged failed attempts for ${identity})`);
}
