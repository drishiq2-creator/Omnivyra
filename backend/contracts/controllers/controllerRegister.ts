/**
 * Controller ownership register (Agent A, 2026-11-28).
 *
 * One row per controller: what it is responsible for, which catalogue events it
 * publishes and consumes, which EXISTING modules it maps to today, and which
 * shared services it depends on. STRUCTURAL CONTRACT ONLY - nothing is moved or
 * wired; the mapping describes the code as it is.
 *
 * publishes / consumes are written out (not derived) so a reader sees them here,
 * and the contract test asserts they equal what the catalogue derives - the two
 * cannot drift.
 *
 * OWNER. The approved owner list covers shared services only; no controller
 * owner was approved, so every controller is 'UNASSIGNED' (an open question for
 * the coordinator), not a guess.
 */
import type { ControllerId } from './controllerIds';
import type { SharedServiceId, SharedServiceOwner } from './sharedServiceRegister';

export type ControllerRecord = {
  id: ControllerId;
  name: string;
  responsibilities: readonly string[];
  /** Catalogue programme names. */
  publishes: readonly string[];
  consumes: readonly string[];
  /** Real repo-relative paths (asserted to exist by the contract test). Empty = nothing exists yet. */
  existing_modules: readonly string[];
  shared_service_dependencies: readonly SharedServiceId[];
  owner: SharedServiceOwner;
  status: 'existing_modules_mapped' | 'contract_only';
  notes?: readonly string[];
};

const COMMON: readonly SharedServiceId[] = ['event_contracts', 'tenant_context_contracts', 'tenant_company_resolution', 'observability'];

export const CONTROLLER_REGISTER: readonly ControllerRecord[] = Object.freeze([
  {
    id: 'lead_intelligence',
    name: 'Lead Intelligence',
    responsibilities: [
      'detect prospect and market signals (Prospect Intelligence, MarketPulse, listening)',
      'enrich and qualify prospects',
      'own the human lead review decision (approve / reject) and list membership',
      'recommend next best action for a lead',
    ],
    publishes: [
      'ProspectSignalDetected', 'MarketSignalDetected', 'ProspectEnrichmentRequested', 'ProspectEnrichmentCompleted',
      'ProspectQualificationRequested', 'ProspectQualificationCompleted', 'LeadReviewRequested', 'LeadApproved',
      'LeadRejected', 'LeadAddedToList', 'NextBestActionRecommended',
    ],
    consumes: [
      'ProspectSignalDetected', 'MarketSignalDetected', 'ProspectEnrichmentRequested', 'ProspectEnrichmentCompleted',
      'ProspectQualificationRequested', 'ProspectQualificationCompleted', 'LeadReviewRequested', 'LeadApproved',
      'LeadRejected', 'EngagementDetected', 'EngagementClassified', 'ExecutionCompleted', 'ExecutionFailed', 'ExecutionOutcomeUnknown',
      'InboundResponseReceived', 'VoiceSessionCompleted',
    ],
    existing_modules: [
      'backend/services/marketPulse/prospectIntelligence.ts',
      'backend/apiHandlers/prospects/prospectIntelligenceRead.ts',
      'backend/services/marketPulseEngine.ts',
      'backend/services/marketPulseV2Service.ts',
      'backend/services/listeningSignalPipeline.ts',
      'backend/services/canonicalLeadSignalService.ts',
      'backend/services/leadIngestion/orchestrator.ts',
      'backend/services/prospectDiscovery/index.ts',
      'backend/services/enrichment/service.ts',
      'backend/services/qualificationIntelligence/index.ts',
      'backend/services/leadIntelligence/leadIntelligenceFacade.ts',
      'backend/services/leadIntelligenceOrchestration/orchestrator.ts',
      'backend/services/prospectImportReview/screen.ts',
      'backend/services/prospectLifecycle/index.ts',
      'backend/services/leadOutreachExecution/approvalQueue.ts',
      'backend/services/leadOutreachExecution/approval.ts',
    ],
    shared_service_dependencies: [...COMMON, 'capability_registry', 'job_lifecycle_retry'],
    owner: 'UNASSIGNED',
    status: 'existing_modules_mapped',
    notes: [
      'approvalQueue.ts / approval.ts approve outreach TASKS (per lead, before contact) on the a9 outreach track today; mapped here per the programme brief, ownership split to be confirmed.',
    ],
  },
  {
    id: 'engagement_intelligence',
    name: 'Engagement Intelligence',
    responsibilities: [
      'ingest and normalise engagement into engagement_threads / engagement_messages',
      'classify engagement and detect prospect signals in it',
      'recommend responses (community_ai_actions suggestions) - never send them',
    ],
    publishes: [
      'ProspectSignalDetected', 'EngagementDetected', 'EngagementClassified', 'ResponseRecommendationCreated',
      'ChannelExecutionRequested', 'InboundResponseReceived', 'NextBestActionRecommended',
    ],
    consumes: [
      'EngagementDetected', 'EngagementClassified', 'ResponseRecommendationCreated', 'ExecutionCompleted',
      'ExecutionFailed', 'ExecutionOutcomeUnknown', 'InboundResponseReceived',
    ],
    existing_modules: [
      'backend/services/engagementIngestionService.ts',
      'backend/services/engagementNormalizationService.ts',
      'backend/services/engagementThreadService.ts',
      'backend/services/engagementMessageService.ts',
      'backend/services/engagementThreadEventService.ts',
      'backend/services/engagementConversationIntelligenceService.ts',
      'backend/services/engagementOpportunityEngine.ts',
      'backend/services/engagementAiAssistantService.ts',
      'backend/services/engagement/prospectEngagementIntelligence.ts',
      'backend/services/communityAiAutoRuleService.ts',
    ],
    shared_service_dependencies: [...COMMON, 'token_storage', 'account_binding', 'capability_registry', 'execution_policy'],
    owner: 'UNASSIGNED',
    status: 'existing_modules_mapped',
  },
  {
    id: 'outreach_orchestration',
    name: 'Outreach Orchestration',
    responsibilities: [
      'decide what to do next for a lead or campaign',
      'request campaign and channel execution',
      'the ONLY source of Voice SDR objectives',
    ],
    publishes: [
      'ProspectEnrichmentRequested', 'ProspectQualificationRequested', 'CampaignExecutionRequested',
      'ChannelExecutionRequested', 'VoiceSessionRequested',
    ],
    consumes: [
      'ProspectSignalDetected', 'MarketSignalDetected', 'ProspectEnrichmentCompleted', 'ProspectQualificationCompleted',
      'LeadApproved', 'LeadRejected', 'LeadAddedToList', 'EngagementClassified', 'ResponseRecommendationCreated',
      'ExecutionCompleted', 'ExecutionFailed', 'ExecutionOutcomeUnknown', 'InboundResponseReceived', 'NextBestActionRecommended',
      'VoiceSessionStarted', 'VoiceSessionCompleted', 'VoiceSessionFailed', 'VoiceSessionOutcomeUnknown',
    ],
    existing_modules: [
      'backend/services/orchestration/index.ts',
      'backend/services/campaign/campaignService.ts',
      'backend/services/campaignAiOrchestrator.ts',
      'backend/services/campaignExecutionStateService.ts',
      'lib/campaign/assignmentExecutionSync.ts',
      'backend/services/leadOutreachExecution/lifecycle.ts',
      'backend/services/leadOutreachExecution/materialization.ts',
    ],
    shared_service_dependencies: [...COMMON, 'capability_registry', 'execution_policy', 'job_lifecycle_retry', 'events_infrastructure'],
    owner: 'UNASSIGNED',
    status: 'existing_modules_mapped',
  },
  {
    id: 'voice_sdr',
    name: 'Voice SDR',
    responsibilities: [
      'run a voice session against an objective handed over by Outreach Orchestration',
      'report technical call outcome and business disposition on separate axes',
    ],
    publishes: ['VoiceSessionStarted', 'VoiceSessionCompleted', 'VoiceSessionFailed', 'VoiceSessionOutcomeUnknown'],
    consumes: ['VoiceSessionRequested'],
    existing_modules: [],
    shared_service_dependencies: [...COMMON, 'capability_registry', 'execution_policy'],
    owner: 'UNASSIGNED',
    status: 'contract_only',
    notes: [
      'No voice implementation exists; channelCapabilityModel.ts declares channel "voice" NOT_OPERATIONAL. See ADR-0003.',
    ],
  },
  {
    id: 'channel_execution',
    name: 'Channel Execution',
    responsibilities: [
      'perform one channel action per request, idempotently',
      'report the outcome verbatim: Completed (attempted | accepted | delivered), Failed (not_attempted | failed), OutcomeUnknown (unknown)',
      'receive inbound responses on a channel',
    ],
    publishes: ['ExecutionCompleted', 'ExecutionFailed', 'ExecutionOutcomeUnknown', 'InboundResponseReceived'],
    consumes: ['CampaignExecutionRequested', 'ChannelExecutionRequested'],
    existing_modules: [
      'backend/services/platformConnectors/baseConnector.ts',
      'backend/services/communityAiActionExecutor.ts',
      'backend/services/communityAiActionExecutorRuntime.ts',
      'backend/services/communityAiExecutionResultService.ts',
      'lib/engagementCapabilities.ts',
      'backend/services/leadOutreachExecution/dispatch.ts',
      'backend/services/leadOutreachExecution/transport.ts',
      'backend/services/leadOutreachExecution/emailTransport.ts',
      'backend/services/leadOutreachExecution/feedbackIngestion.ts',
      'backend/services/execution/emailExecutionConnector.ts',
    ],
    shared_service_dependencies: [
      ...COMMON, 'token_storage', 'account_binding', 'capability_registry', 'execution_policy', 'transport_pairing', 'job_lifecycle_retry',
    ],
    owner: 'UNASSIGNED',
    status: 'existing_modules_mapped',
    notes: [
      'platformConnectors ExecutionResult is { success: boolean } today - it cannot express accepted vs delivered vs unknown; mapping it onto the outcome vocabulary is future work, not done here.',
    ],
  },
] satisfies ControllerRecord[]);
