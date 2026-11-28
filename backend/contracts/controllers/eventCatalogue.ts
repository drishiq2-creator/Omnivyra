/**
 * Controller event catalogue + publication rules (Agent A, 2026-11-28).
 *
 * STRUCTURAL CONTRACT ONLY. No runtime service publishes or consumes these yet.
 *
 * NAMING. A programme event that ALREADY exists in the codebase with the same
 * meaning keeps its existing wire name (no duplicate event type). Today that is
 * exactly one: ProspectSignalDetected == 'lead_signal.created'
 * (backend/events/listeningEventsCore.ts, LeadSignalCreatedEvent; published by
 * backend/services/listeningSignalPipeline.ts with source_type
 * 'engagement' | 'listening'). Every other programme event has no existing
 * equivalent and uses its programme name as the wire name. Names that LOOK
 * similar but mean something else are recorded in `not_equivalent_to` so the
 * decision is visible and testable (e.g. listening 'execution.completed' is a
 * listening-source crawl run, not a channel send).
 *
 * PAYLOADS are minimal: ids, codes, enums, versions. No names, emails, phone
 * numbers, message bodies or free text - PII stays in the owning store and is
 * read by id. Every payload schema is strict (unknown keys rejected).
 *
 * BUSINESS RULES encoded here (checked by `checkEventPublication`):
 *   R1 only Lead Intelligence may publish LeadApproved / LeadRejected, and both
 *      require a human approver (approver_kind 'human' + approver_user_id).
 *      LIMIT OF THE CONTRACT: the approver is required STRUCTURALLY only. The
 *      contract cannot know whether approver_user_id is a real, active user of
 *      THIS tenant/company, or that a human (not a script using a user id) made
 *      the decision. The Lead Intelligence producer MUST verify the approver
 *      against the tenant's users (and the decision against its approval record)
 *      at runtime before publishing; consumers may not treat a schema-valid
 *      LeadApproved as proof of that verification beyond the producer's duty;
 *   R2 Engagement Intelligence may publish ProspectSignalDetected, never
 *      LeadApproved / LeadRejected (follows from R1; asserted separately);
 *   R3 Voice SDR receives objectives ONLY from Outreach Orchestration: every
 *      event Voice SDR consumes is produced only by Outreach Orchestration, and
 *      an envelope targeting voice_sdr must come from outreach_orchestration;
 *   R4 Channel Execution outcome events carry exactly one of
 *      not_attempted | attempted | accepted | delivered | failed | unknown,
 *      and each value travels in exactly one event:
 *        ExecutionCompleted      attempted | accepted | delivered
 *        ExecutionFailed         not_attempted | failed
 *        ExecutionOutcomeUnknown unknown   (the ONLY event that may carry it)
 *      Voice SDR mirrors this on payload.call_outcome: VoiceSessionCompleted
 *      (attempted | accepted | delivered), VoiceSessionFailed (not_attempted |
 *      failed), VoiceSessionOutcomeUnknown (unknown - the only voice event that may).
 *      A missing or unrecognised outcome is REJECTED, never defaulted; 'unknown'
 *      is preserved as 'unknown' (never coerced to success or failure) and no
 *      outcome payload may carry a success/failure boolean beside it.
 */
import { z } from 'zod';
import { CONTROLLER_IDS, type ControllerId } from './controllerIds';
import { formatIssuePath, validateEventEnvelope, type EventEnvelope } from './eventEnvelope';

/** The channel-execution outcome vocabulary (R4). Order carries no meaning. */
export const EXECUTION_OUTCOMES = ['not_attempted', 'attempted', 'accepted', 'delivered', 'failed', 'unknown'] as const;
export type ExecutionOutcome = (typeof EXECUTION_OUTCOMES)[number];
export const ExecutionOutcomeSchema = z.enum(EXECUTION_OUTCOMES);

/** Outcomes an ExecutionCompleted may carry: the side effect happened or may have happened. */
export const COMPLETED_OUTCOMES = ['attempted', 'accepted', 'delivered'] as const satisfies readonly ExecutionOutcome[];
/** Outcomes an ExecutionFailed may carry: definitively not done. 'unknown' is NOT a failure. */
export const FAILED_OUTCOMES = ['not_attempted', 'failed'] as const satisfies readonly ExecutionOutcome[];
/** The outcome only ExecutionOutcomeUnknown may carry: the side effect may or may not have happened. */
export const UNKNOWN_OUTCOMES = ['unknown'] as const satisfies readonly ExecutionOutcome[];
/** The one event allowed to carry outcome 'unknown'. */
export const UNKNOWN_OUTCOME_EVENT = 'ExecutionOutcomeUnknown' as const;
/** The one VOICE event allowed to carry call_outcome 'unknown' (coordinator decision, 2026-11-28). */
export const VOICE_UNKNOWN_OUTCOME_EVENT = 'VoiceSessionOutcomeUnknown' as const;

const Id = z.string().min(1).max(200);
const Code = z.string().regex(/^[a-z][a-z0-9_.:-]{0,79}$/, 'must be a lowercase code');
const Version = z.string().min(1).max(64);
const Channel = Code;

export type CatalogueEntry = {
  /** Programme name (PascalCase), unique. */
  programme_name: string;
  /** Wire name carried in envelope.event_type. Equals programme_name unless an existing name is reused. */
  event_type: string;
  event_version: number;
  producers: readonly ControllerId[];
  consumers: readonly ControllerId[];
  entity_type: string;
  payload: z.ZodType<Record<string, unknown>>;
  /** Set only when an existing event with the SAME meaning is reused. */
  existing_equivalent?: { event_type: string; defined_in: string; published_by: readonly string[] };
  /** Existing names deliberately NOT reused, with the reason. */
  not_equivalent_to?: readonly { event_type: string; defined_in: string; reason: string }[];
  /** R1: requires a human approver in the payload. */
  requires_human_approver?: true;
  /** R4: carries a channel-execution outcome in payload.outcome. */
  outcome_bearing?: true;
  /** Voice SDR outcome event: carries a technical call outcome in payload.call_outcome. */
  call_outcome_bearing?: true;
  description: string;
};

const LI: ControllerId = 'lead_intelligence';
const EI: ControllerId = 'engagement_intelligence';
const OO: ControllerId = 'outreach_orchestration';
const VS: ControllerId = 'voice_sdr';
const CE: ControllerId = 'channel_execution';

const HumanDecision = {
  lead_id: Id,
  approver_kind: z.literal('human'),
  approver_user_id: z.uuid(),
  decided_at: z.iso.datetime({ offset: true }),
};

const LISTENING_CORE = 'backend/events/listeningEventsCore.ts';

export const EVENT_CATALOGUE: readonly CatalogueEntry[] = Object.freeze([
  {
    programme_name: 'ProspectSignalDetected',
    event_type: 'lead_signal.created',
    event_version: 1,
    producers: [LI, EI],
    consumers: [LI, OO],
    entity_type: 'lead_signal',
    payload: z.strictObject({
      lead_signal_id: Id,
      platform: Code,
      source_type: z.enum(['engagement', 'listening']),
    }),
    existing_equivalent: {
      event_type: 'lead_signal.created',
      defined_in: LISTENING_CORE,
      published_by: ['backend/services/listeningSignalPipeline.ts'],
    },
    description: 'A buying/intent signal about a prospect was detected (from listening or from engagement).',
  },
  {
    programme_name: 'MarketSignalDetected',
    event_type: 'MarketSignalDetected',
    event_version: 1,
    producers: [LI],
    consumers: [LI, OO],
    entity_type: 'market_signal',
    payload: z.strictObject({ market_signal_id: Id, signal_category: Code }),
    not_equivalent_to: [
      { event_type: 'signals.detected', defined_in: LISTENING_CORE, reason: 'a per-crawl COUNT of listening signals, not one market signal' },
      { event_type: 'trend_detected', defined_in: 'backend/services/intelligenceEventService.ts', reason: 'an intelligence_events log row type for trends; not a controller event and narrower than a market signal' },
    ],
    description: 'A market-level (not prospect-level) signal was detected, e.g. by MarketPulse.',
  },
  {
    programme_name: 'ProspectEnrichmentRequested',
    event_type: 'ProspectEnrichmentRequested',
    event_version: 1,
    producers: [LI, OO],
    consumers: [LI],
    entity_type: 'prospect',
    payload: z.strictObject({ prospect_id: Id, requested_attributes: z.array(Code).min(1).max(50) }),
    description: 'Enrichment of named attributes was requested for a prospect.',
  },
  {
    programme_name: 'ProspectEnrichmentCompleted',
    event_type: 'ProspectEnrichmentCompleted',
    event_version: 1,
    producers: [LI],
    consumers: [LI, OO],
    entity_type: 'prospect',
    payload: z.strictObject({
      prospect_id: Id,
      enrichment_status: z.enum(['enriched', 'partial', 'not_found', 'failed', 'unknown']),
    }),
    description: 'An enrichment request finished. "unknown" means the provider result could not be read.',
  },
  {
    programme_name: 'ProspectQualificationRequested',
    event_type: 'ProspectQualificationRequested',
    event_version: 1,
    producers: [LI, OO],
    consumers: [LI],
    entity_type: 'prospect',
    payload: z.strictObject({ prospect_id: Id, policy_version: Version.nullable() }),
    description: 'Qualification of a prospect against the ICP/qualification policy was requested.',
  },
  {
    programme_name: 'ProspectQualificationCompleted',
    event_type: 'ProspectQualificationCompleted',
    event_version: 1,
    producers: [LI],
    consumers: [LI, OO],
    entity_type: 'prospect',
    payload: z.strictObject({
      prospect_id: Id,
      qualification_status: z.enum(['qualified', 'disqualified', 'insufficient_evidence']),
      engine_version: Version,
    }),
    description: 'A qualification decision was produced by the engine (not a human approval).',
  },
  {
    programme_name: 'LeadReviewRequested',
    event_type: 'LeadReviewRequested',
    event_version: 1,
    producers: [LI],
    consumers: [LI],
    entity_type: 'lead',
    payload: z.strictObject({ lead_id: Id, reason_code: Code }),
    description: 'A lead needs a human review decision before it may be used for outreach.',
  },
  {
    programme_name: 'LeadApproved',
    event_type: 'LeadApproved',
    event_version: 1,
    producers: [LI],
    consumers: [LI, OO],
    entity_type: 'lead',
    payload: z.strictObject(HumanDecision),
    requires_human_approver: true,
    not_equivalent_to: [
      { event_type: 'recommendation.approved', defined_in: LISTENING_CORE, reason: 'approval of a listening recommendation, not of a lead' },
    ],
    description: 'A human approved a lead. Only Lead Intelligence publishes this; never a model or rule. approver_user_id is structurally required; the producer must verify it against the tenant\'s users at runtime (the contract cannot).',
  },
  {
    programme_name: 'LeadRejected',
    event_type: 'LeadRejected',
    event_version: 1,
    producers: [LI],
    consumers: [LI, OO],
    entity_type: 'lead',
    payload: z.strictObject({ ...HumanDecision, reason_code: Code }),
    requires_human_approver: true,
    not_equivalent_to: [
      { event_type: 'recommendation.rejected', defined_in: LISTENING_CORE, reason: 'rejection of a listening recommendation, not of a lead' },
    ],
    description: 'A human rejected a lead. Only Lead Intelligence publishes this. approver_user_id is structurally required; the producer must verify it against the tenant\'s users at runtime (the contract cannot).',
  },
  {
    programme_name: 'LeadAddedToList',
    event_type: 'LeadAddedToList',
    event_version: 1,
    producers: [LI],
    consumers: [OO],
    entity_type: 'lead',
    payload: z.strictObject({ lead_id: Id, list_id: Id }),
    description: 'A lead was added to a list that orchestration may draw from.',
  },
  {
    programme_name: 'EngagementDetected',
    event_type: 'EngagementDetected',
    event_version: 1,
    producers: [EI],
    consumers: [EI, LI],
    entity_type: 'engagement_thread',
    payload: z.strictObject({ thread_id: Id, message_id: Id.nullable(), platform: Code }),
    not_equivalent_to: [
      { event_type: 'engagement_spike', defined_in: 'backend/services/intelligenceEventService.ts', reason: 'an aggregate spike log row, not one detected engagement' },
    ],
    description: 'An inbound engagement (comment, mention, reply on a social thread) was ingested.',
  },
  {
    programme_name: 'EngagementClassified',
    event_type: 'EngagementClassified',
    event_version: 1,
    producers: [EI],
    consumers: [EI, LI, OO],
    entity_type: 'engagement_thread',
    payload: z.strictObject({ thread_id: Id, classification: Code, classifier_version: Version }),
    description: 'An engagement thread/message was classified (intent, sentiment bucket, lead-likeness).',
  },
  {
    programme_name: 'ResponseRecommendationCreated',
    event_type: 'ResponseRecommendationCreated',
    event_version: 1,
    producers: [EI],
    consumers: [EI, OO],
    entity_type: 'engagement_thread',
    payload: z.strictObject({ thread_id: Id, recommendation_id: Id, requires_human_approval: z.boolean() }),
    not_equivalent_to: [
      { event_type: 'recommendation.generated', defined_in: LISTENING_CORE, reason: 'listening recommendation lifecycle, not a reply suggestion for an engagement thread' },
    ],
    description: 'A suggested response to an engagement was created. It is a recommendation, not a send.',
  },
  {
    programme_name: 'CampaignExecutionRequested',
    event_type: 'CampaignExecutionRequested',
    event_version: 1,
    producers: [OO],
    consumers: [CE],
    entity_type: 'campaign',
    payload: z.strictObject({ campaign_id: Id, execution_request_id: Id }),
    not_equivalent_to: [
      { event_type: 'publish_started', defined_in: 'lib/campaign/assignmentExecutionSync.ts', reason: 'records that publishing began; not a request to execute' },
    ],
    description: 'Orchestration asked for a campaign step to be executed.',
  },
  {
    programme_name: 'ChannelExecutionRequested',
    event_type: 'ChannelExecutionRequested',
    event_version: 1,
    producers: [OO, EI],
    consumers: [CE],
    entity_type: 'execution_request',
    payload: z.strictObject({
      execution_request_id: Id,
      channel: Channel,
      action: Code,
      /** Must be the SAME key the executor's ledger uses; never synthesised per attempt. */
      idempotency_key: Id,
    }),
    description: 'A single channel action (send, reply, post) was requested of Channel Execution.',
  },
  {
    programme_name: 'ExecutionCompleted',
    event_type: 'ExecutionCompleted',
    event_version: 1,
    producers: [CE],
    consumers: [OO, EI, LI],
    entity_type: 'execution_request',
    payload: z.strictObject({
      execution_request_id: Id,
      channel: Channel,
      outcome: z.enum(COMPLETED_OUTCOMES),
      provider_reference: Id.nullable(),
    }),
    outcome_bearing: true,
    not_equivalent_to: [
      { event_type: 'execution.completed', defined_in: LISTENING_CORE, reason: 'a listening-source crawl run finished; not a channel action' },
      { event_type: 'publish_completed', defined_in: 'lib/campaign/assignmentExecutionSync.ts', reason: 'campaign assignment sync for scheduled posts only' },
    ],
    description: 'Channel Execution performed the action and knows it: attempted, accepted by the provider, or delivered. Never carries "unknown" - see ExecutionOutcomeUnknown.',
  },
  {
    programme_name: 'ExecutionFailed',
    event_type: 'ExecutionFailed',
    event_version: 1,
    producers: [CE],
    consumers: [OO, EI, LI],
    entity_type: 'execution_request',
    payload: z.strictObject({
      execution_request_id: Id,
      channel: Channel,
      outcome: z.enum(FAILED_OUTCOMES),
      failure_code: Code,
    }),
    outcome_bearing: true,
    not_equivalent_to: [
      { event_type: 'execution.failed', defined_in: LISTENING_CORE, reason: 'a listening-source crawl run failed; not a channel action' },
    ],
    description: 'Channel Execution definitively did not perform the action (never attempted, or the provider definitively refused).',
  },
  {
    programme_name: 'ExecutionOutcomeUnknown',
    event_type: 'ExecutionOutcomeUnknown',
    event_version: 1,
    producers: [CE],
    consumers: [OO, EI, LI],
    entity_type: 'execution_request',
    payload: z.strictObject({
      execution_request_id: Id,
      channel: Channel,
      outcome: z.enum(UNKNOWN_OUTCOMES),
      /** Why the outcome cannot be known, e.g. response_lost, timeout_after_send, receipt_unreadable. */
      unknown_reason_code: Code,
    }),
    outcome_bearing: true,
    description: 'The side effect may or may not have happened (lost response, timeout after the provider call). Consumers must not retry the side effect, must not count it delivered, and must not count it failed; it stays unknown until reconciled.',
  },
  {
    programme_name: 'InboundResponseReceived',
    event_type: 'InboundResponseReceived',
    event_version: 1,
    producers: [CE, EI],
    consumers: [OO, EI, LI],
    entity_type: 'inbound_message',
    payload: z.strictObject({
      inbound_message_id: Id,
      channel: Channel,
      related_execution_request_id: Id.nullable(),
      thread_id: Id.nullable(),
    }),
    not_equivalent_to: [
      { event_type: 'replied', defined_in: 'backend/services/engagementThreadEventService.ts', reason: 'an OPERATOR reply recorded on a thread, i.e. outbound' },
    ],
    description: 'A prospect responded on a channel (reply to outreach, DM, inbound email).',
  },
  {
    programme_name: 'NextBestActionRecommended',
    event_type: 'NextBestActionRecommended',
    event_version: 1,
    producers: [LI, EI],
    consumers: [OO],
    entity_type: 'lead',
    payload: z.strictObject({ lead_id: Id, action_code: Code, recommender_version: Version }),
    description: 'An intelligence controller recommends the next action for a lead; Outreach Orchestration decides.',
  },
  {
    programme_name: 'VoiceSessionRequested',
    event_type: 'VoiceSessionRequested',
    event_version: 1,
    producers: [OO],
    consumers: [VS],
    entity_type: 'voice_session',
    payload: z.strictObject({
      voice_session_id: Id,
      lead_id: Id,
      objective_code: Code,
      objective_version: Version,
    }),
    description: 'Outreach Orchestration hands Voice SDR an objective. The ONLY source of Voice SDR objectives.',
  },
  {
    programme_name: 'VoiceSessionStarted',
    event_type: 'VoiceSessionStarted',
    event_version: 1,
    producers: [VS],
    consumers: [OO],
    entity_type: 'voice_session',
    payload: z.strictObject({ voice_session_id: Id }),
    description: 'A voice session began (contract only; no voice transport exists).',
  },
  {
    programme_name: 'VoiceSessionCompleted',
    event_type: 'VoiceSessionCompleted',
    event_version: 1,
    producers: [VS],
    consumers: [OO, LI],
    entity_type: 'voice_session',
    payload: z.strictObject({
      voice_session_id: Id,
      /** Technical call status - kept separate from the business disposition. */
      call_outcome: z.enum(COMPLETED_OUTCOMES),
      disposition_code: Code.nullable(),
    }),
    call_outcome_bearing: true,
    description: 'A voice session ended with a known technical outcome. call_outcome (technical) and disposition_code (what happened) are separate axes. Never carries "unknown" - see VoiceSessionOutcomeUnknown.',
  },
  {
    programme_name: 'VoiceSessionFailed',
    event_type: 'VoiceSessionFailed',
    event_version: 1,
    producers: [VS],
    consumers: [OO],
    entity_type: 'voice_session',
    payload: z.strictObject({
      voice_session_id: Id,
      call_outcome: z.enum(FAILED_OUTCOMES),
      failure_code: Code,
    }),
    call_outcome_bearing: true,
    description: 'A voice session definitively did not take place.',
  },
  {
    programme_name: 'VoiceSessionOutcomeUnknown',
    event_type: 'VoiceSessionOutcomeUnknown',
    event_version: 1,
    producers: [VS],
    consumers: [OO],
    entity_type: 'voice_session',
    payload: z.strictObject({
      voice_session_id: Id,
      call_outcome: z.enum(UNKNOWN_OUTCOMES),
      /** Why the call outcome cannot be known, e.g. status_callback_lost, timeout_after_dial. */
      unknown_reason_code: Code,
    }),
    call_outcome_bearing: true,
    description: 'Mirrors ExecutionOutcomeUnknown for voice: the call may or may not have connected. Orchestration must not redial as if it had not happened, nor count it completed or failed, until reconciled. The ONLY voice event that may carry "unknown".',
  },
] satisfies CatalogueEntry[]);

export function findCatalogueEntry(eventType: string, eventVersion: number): CatalogueEntry | undefined {
  return EVENT_CATALOGUE.find((e) => e.event_type === eventType && e.event_version === eventVersion);
}

export function findByProgrammeName(name: string): CatalogueEntry | undefined {
  return EVENT_CATALOGUE.find((e) => e.programme_name === name);
}

/** Events a controller may publish / consume, derived from the catalogue (the single source). */
export function eventsPublishedBy(controller: ControllerId): string[] {
  return EVENT_CATALOGUE.filter((e) => e.producers.includes(controller)).map((e) => e.programme_name);
}
export function eventsConsumedBy(controller: ControllerId): string[] {
  return EVENT_CATALOGUE.filter((e) => e.consumers.includes(controller)).map((e) => e.programme_name);
}

/**
 * Structural integrity of the catalogue itself. Returns every violation (empty = sound).
 * Encodes R1-R4 at the catalogue level so a future edit cannot quietly widen them.
 */
export function catalogueIntegrityViolations(catalogue: readonly CatalogueEntry[] = EVENT_CATALOGUE): string[] {
  const v: string[] = [];
  const known = new Set<string>(CONTROLLER_IDS);
  const keys = new Set<string>();
  const names = new Set<string>();
  for (const e of catalogue) {
    const key = `${e.event_type}@${e.event_version}`;
    if (keys.has(key)) v.push(`duplicate event_type+version ${key}`);
    keys.add(key);
    if (names.has(e.programme_name)) v.push(`duplicate programme_name ${e.programme_name}`);
    names.add(e.programme_name);
    if (e.producers.length === 0) v.push(`${e.programme_name}: no producer`);
    if (e.consumers.length === 0) v.push(`${e.programme_name}: no consumer`);
    for (const c of [...e.producers, ...e.consumers]) {
      if (!known.has(c)) v.push(`${e.programme_name}: unknown controller ${c}`);
    }
    if (e.event_type !== e.programme_name && !e.existing_equivalent) {
      v.push(`${e.programme_name}: wire name differs from programme name without an existing_equivalent`);
    }
    if (e.existing_equivalent && e.existing_equivalent.event_type !== e.event_type) {
      v.push(`${e.programme_name}: existing_equivalent must be carried as the wire name`);
    }
    // R1 / R2
    if (e.requires_human_approver) {
      if (e.producers.length !== 1 || e.producers[0] !== 'lead_intelligence') {
        v.push(`${e.programme_name}: human-approval events may be produced only by lead_intelligence`);
      }
    }
    if ((e.programme_name === 'LeadApproved' || e.programme_name === 'LeadRejected') && !e.requires_human_approver) {
      v.push(`${e.programme_name}: must require a human approver`);
    }
    // R3
    if (e.consumers.includes('voice_sdr') && (e.producers.length !== 1 || e.producers[0] !== 'outreach_orchestration')) {
      v.push(`${e.programme_name}: voice_sdr may consume only events produced solely by outreach_orchestration`);
    }
    // R4
    if (e.outcome_bearing && (e.producers.length !== 1 || e.producers[0] !== 'channel_execution')) {
      v.push(`${e.programme_name}: outcome-bearing events are produced only by channel_execution`);
    }
    if (e.producers.includes('channel_execution') && /^Execution/.test(e.programme_name) && !e.outcome_bearing) {
      v.push(`${e.programme_name}: channel_execution outcome event must be outcome_bearing`);
    }
    if (e.call_outcome_bearing) {
      if (e.producers.length !== 1 || e.producers[0] !== 'voice_sdr') {
        v.push(`${e.programme_name}: call-outcome events are produced only by voice_sdr`);
      }
      const options = outcomeOptions(e, 'call_outcome');
      if (!options) v.push(`${e.programme_name}: call_outcome must be declared as a z.enum`);
      else if (options.includes('unknown') !== (e.programme_name === VOICE_UNKNOWN_OUTCOME_EVENT)) {
        v.push(`${e.programme_name}: call_outcome 'unknown' may travel only in ${VOICE_UNKNOWN_OUTCOME_EVENT}`);
      }
    }
    if (e.producers.includes('voice_sdr') && /^VoiceSession(?!Started)/.test(e.programme_name) && !e.call_outcome_bearing) {
      v.push(`${e.programme_name}: voice_sdr outcome event must be call_outcome_bearing`);
    }
    if (e.outcome_bearing) {
      const options = outcomeOptions(e);
      if (!options) v.push(`${e.programme_name}: outcome must be declared as a z.enum`);
      else if (options.includes('unknown') !== (e.programme_name === UNKNOWN_OUTCOME_EVENT)) {
        v.push(`${e.programme_name}: outcome 'unknown' may travel only in ${UNKNOWN_OUTCOME_EVENT}`);
      }
    }
  }
  return v;
}

/** The enum values an outcome-bearing row's payload.outcome accepts, or null if not a plain z.enum. */
export function outcomeOptions(e: CatalogueEntry, field: 'outcome' | 'call_outcome' = 'outcome'): string[] | null {
  const shape = (e.payload as unknown as { shape?: Record<string, unknown> }).shape;
  const outcome = shape?.[field] as { options?: unknown } | undefined;
  return Array.isArray(outcome?.options) ? (outcome!.options as string[]) : null;
}

export type PublicationCheck =
  | { ok: true; envelope: EventEnvelope; entry: CatalogueEntry; errors: [] }
  | { ok: false; errors: string[] };

/**
 * Full contract check for one envelope a controller wants to publish:
 * envelope shape + credential scan, catalogue membership, producer/consumer,
 * entity type, strict payload schema, and the business rules R1-R4.
 * Never throws; never defaults a missing value.
 */
export function checkEventPublication(raw: unknown): PublicationCheck {
  try {
    return checkEventPublicationUnsafe(raw);
  } catch {
    return { ok: false, errors: ['(envelope): publication_check_error'] };
  }
}

function checkEventPublicationUnsafe(raw: unknown): PublicationCheck {
  const shape = validateEventEnvelope(raw);
  if (!shape.ok) return { ok: false, errors: shape.errors };
  const env = shape.envelope;
  const errors: string[] = [];

  const entry = findCatalogueEntry(env.event_type, env.event_version);
  if (!entry) return { ok: false, errors: [`event_type: ${env.event_type}@${env.event_version} is not in the catalogue`] };

  if (!entry.producers.includes(env.source_controller)) {
    errors.push(`source_controller: ${env.source_controller} may not publish ${entry.programme_name}`);
  }
  if (env.target_controller !== undefined && !entry.consumers.includes(env.target_controller)) {
    errors.push(`target_controller: ${env.target_controller} does not consume ${entry.programme_name}`);
  }
  // R3 (envelope level, independent of the catalogue row): nothing reaches voice_sdr except from orchestration.
  if (env.target_controller === 'voice_sdr' && env.source_controller !== 'outreach_orchestration') {
    errors.push('target_controller: voice_sdr receives objectives only from outreach_orchestration');
  }
  if (env.entity_type !== entry.entity_type) {
    errors.push(`entity_type: ${entry.programme_name} is about ${entry.entity_type}, not ${env.entity_type}`);
  }
  const payload = entry.payload.safeParse(env.payload);
  if (!payload.success) {
    for (const issue of payload.error.issues) errors.push(`payload.${formatIssuePath(issue.path as PropertyKey[])}: ${String(issue.message)}`);
  }
  // R1 belt-and-braces: the schema already demands it; this survives a schema edit.
  if (entry.requires_human_approver) {
    const p = env.payload as Record<string, unknown>;
    if (p.approver_kind !== 'human' || typeof p.approver_user_id !== 'string' || p.approver_user_id.length === 0) {
      errors.push(`payload: ${entry.programme_name} requires a human approver_user_id`);
    }
  }
  // R4 belt-and-braces: an outcome is one of the six values, verbatim.
  if (entry.outcome_bearing) {
    const outcome = (env.payload as Record<string, unknown>).outcome;
    if (typeof outcome !== 'string' || !(EXECUTION_OUTCOMES as readonly string[]).includes(outcome)) {
      errors.push(`payload.outcome: must be one of ${EXECUTION_OUTCOMES.join(' | ')}`);
    }
    if (outcome === 'unknown' && entry.programme_name !== UNKNOWN_OUTCOME_EVENT) {
      errors.push(`payload.outcome: 'unknown' travels only in ${UNKNOWN_OUTCOME_EVENT}`);
    }
  }
  if (entry.call_outcome_bearing) {
    const callOutcome = (env.payload as Record<string, unknown>).call_outcome;
    if (typeof callOutcome !== 'string' || !(EXECUTION_OUTCOMES as readonly string[]).includes(callOutcome)) {
      errors.push(`payload.call_outcome: must be one of ${EXECUTION_OUTCOMES.join(' | ')}`);
    }
    if (callOutcome === 'unknown' && entry.programme_name !== VOICE_UNKNOWN_OUTCOME_EVENT) {
      errors.push(`payload.call_outcome: 'unknown' travels only in ${VOICE_UNKNOWN_OUTCOME_EVENT}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, envelope: { ...env, payload: payload.success ? payload.data : env.payload }, entry, errors: [] };
}
