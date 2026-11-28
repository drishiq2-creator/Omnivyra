/**
 * Shared-service register (Agent A, 2026-11-28).
 *
 * The cross-cutting services every controller depends on but no controller owns.
 * STRUCTURAL CONTRACT ONLY: it records where each concern lives TODAY and who is
 * proposed to own it. It does not move, wrap or wire anything.
 *
 * OWNERS are exactly the three values the owner approved; nothing else is
 * invented. "proposed, unconfirmed" and "interim" are part of the value on
 * purpose, so nobody reads a proposal as a decision.
 */

export const SHARED_SERVICE_OWNERS = [
  'control-tower (interim)',
  'a9 (proposed, unconfirmed)',
  'UNASSIGNED',
] as const;
export type SharedServiceOwner = (typeof SHARED_SERVICE_OWNERS)[number];

export const SHARED_SERVICE_IDS = [
  'event_contracts',
  'tenant_context_contracts',
  'migration_coordination',
  'token_storage',
  'account_binding',
  'tenant_company_resolution',
  'capability_registry',
  'execution_policy',
  'transport_pairing',
  'job_lifecycle_retry',
  'events_infrastructure',
  'observability',
] as const;
export type SharedServiceId = (typeof SHARED_SERVICE_IDS)[number];

export type SharedServiceRecord = {
  id: SharedServiceId;
  name: string;
  responsibilities: readonly string[];
  /** Real repo-relative paths (asserted to exist by the contract test). */
  existing_modules: readonly string[];
  owner: SharedServiceOwner;
  notes?: string;
};

export const SHARED_SERVICE_REGISTER: readonly SharedServiceRecord[] = Object.freeze([
  {
    id: 'event_contracts',
    name: 'Shared event contracts',
    responsibilities: ['controller event envelope', 'event catalogue and versioning', 'publication rules'],
    existing_modules: [
      'backend/contracts/controllers/eventEnvelope.ts',
      'backend/contracts/controllers/eventCatalogue.ts',
    ],
    owner: 'control-tower (interim)',
  },
  {
    id: 'tenant_context_contracts',
    name: 'Shared tenant-context contracts',
    responsibilities: ['tenant_id + company_id required on every event', 'request-scoped context propagation shape'],
    existing_modules: ['backend/contracts/controllers/eventEnvelope.ts', 'backend/services/requestContext.ts'],
    owner: 'control-tower (interim)',
  },
  {
    id: 'migration_coordination',
    name: 'Migration coordination',
    responsibilities: ['reserve migration version ids', 'sequence applies across tracks', 'migration quality gate'],
    existing_modules: ['supabase/migrations', 'scripts/check-migration-quality.js'],
    owner: 'control-tower (interim)',
  },
  {
    id: 'token_storage',
    name: 'Token storage',
    responsibilities: ['encrypted provider credential storage', 'token refresh'],
    existing_modules: [
      'backend/auth/tokenStore.ts',
      'backend/auth/credentialEncryption.ts',
      'backend/auth/encryptionKeyRing.ts',
      'backend/auth/tokenRefresh.ts',
    ],
    owner: 'a9 (proposed, unconfirmed)',
  },
  {
    id: 'account_binding',
    name: 'Account binding',
    responsibilities: ['bind a company to the social/provider account used to act', 'member binding for SalesNav'],
    existing_modules: [
      'backend/services/postSocialAccountResolver.ts',
      'backend/auth/refreshAccountResolver.ts',
      'backend/services/salesNav/memberBinding.ts',
    ],
    owner: 'a9 (proposed, unconfirmed)',
  },
  {
    id: 'tenant_company_resolution',
    name: 'Tenant / company resolution',
    responsibilities: ['resolve and authorise the tenant and company for a request or job'],
    existing_modules: ['backend/security/TenantGuard.ts', 'backend/services/campaignAccessService.ts'],
    owner: 'a9 (proposed, unconfirmed)',
  },
  {
    id: 'capability_registry',
    name: 'Capability registry',
    responsibilities: ['which (channel/platform, action) pairs are operational', 'capability map versioning'],
    existing_modules: [
      'lib/engagementCapabilities.ts',
      'backend/services/engagementCapabilityMap.ts',
      'backend/services/leadOutreachExecution/channelCapabilityModel.ts',
      'backend/services/rbac/communityAiCapabilities.ts',
    ],
    owner: 'a9 (proposed, unconfirmed)',
  },
  {
    id: 'execution_policy',
    name: 'Execution policy',
    responsibilities: ['contact governance', 'platform policy', 'suppression', 'execution control'],
    existing_modules: [
      'backend/services/communityAiPlatformPolicyService.ts',
      'backend/services/communityAiContactGovernanceGate.ts',
      'backend/services/leadOutreachExecution/governance.ts',
      'backend/services/execution/executionControlService.ts',
      'backend/services/execution/suppressionService.ts',
    ],
    owner: 'a9 (proposed, unconfirmed)',
  },
  {
    id: 'transport_pairing',
    name: 'Transport and pairing',
    responsibilities: ['browser-extension pairing and sessions', 'outreach transport registry'],
    existing_modules: [
      'backend/services/extensionSessionService.ts',
      'backend/services/extensionClaimCodeService.ts',
      'backend/services/extensionCommandSchema.ts',
      'pages/api/extension/redeem.ts',
      'backend/services/leadOutreachExecution/transportRegistry.ts',
    ],
    owner: 'UNASSIGNED',
  },
  {
    id: 'job_lifecycle_retry',
    name: 'Job lifecycle and retry',
    responsibilities: ['BullMQ queues and workers', 'retry and dead-letter on exhaustion'],
    existing_modules: [
      'backend/queue/bullmqClient.ts',
      'backend/queue/startWorkers.ts',
      'backend/queue/deadLetterOnExhaustion.ts',
      'backend/queue/publishRetryState.ts',
    ],
    owner: 'UNASSIGNED',
  },
  {
    id: 'events_infrastructure',
    name: 'Events infrastructure',
    responsibilities: ['event transport', 'delivery semantics', 'the proposed durable outbox (ADR-0002)'],
    existing_modules: [
      'backend/services/orchestration/events/orchestrationEventBus.ts',
      'backend/services/orchestration/events/distributedOrchestrationEventTransport.ts',
      'backend/services/orchestration/events/durableOrchestrationEventStream.ts',
      'backend/services/plannerEventBus.ts',
      'backend/events/listeningEventsBus.ts',
      'backend/services/domainEventLogger.ts',
    ],
    owner: 'UNASSIGNED',
    notes: 'None of these is a durable outbox for controller events; see ADR-0002.',
  },
  {
    id: 'observability',
    name: 'Observability',
    responsibilities: ['structured logging with redaction', 'metrics and health'],
    existing_modules: [
      'backend/services/logger.ts',
      'backend/security/logRedaction.ts',
      'backend/observability/index.ts',
      'backend/services/leadOutreachExecution/telemetry.ts',
    ],
    owner: 'UNASSIGNED',
  },
] satisfies SharedServiceRecord[]);
