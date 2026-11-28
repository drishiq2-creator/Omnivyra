# ADR-0001 — Five controllers and a shared-service layer

**Status:** Proposed (2026-11-28) · **Scope:** structural contracts only

## Context

Lead, engagement, outreach and execution logic grew in parallel tracks. Each area has
its own event vocabulary (`backend/events/listeningEventsCore.ts`,
`backend/services/orchestration/events/orchestrationEventTypes.ts`,
`backend/services/plannerEventBus.ts`, `lib/campaign/assignmentExecutionSync.ts`,
`backend/services/domainEventLogger.ts`, `backend/services/intelligenceEventService.ts`, …)
and no shared statement of who may decide what. Two properties matter most and were
enforced only by convention: a lead is approved by a human, and an execution outcome
is reported truthfully (a lost response is "unknown", not success or failure).

## Decision

Name five controllers, each with a closed set of events it may publish and consume:

| Controller | Decides | Never does |
|---|---|---|
| Lead Intelligence | signals, enrichment, qualification, the human lead review | send anything |
| Engagement Intelligence | ingest/classify engagement, recommend responses, emit prospect signals | approve a lead |
| Outreach Orchestration | what happens next; requests execution; sole source of Voice SDR objectives | perform a channel action |
| Voice SDR | run a voice session against an objective | take objectives from anyone but orchestration |
| Channel Execution | perform one channel action, report its outcome verbatim | decide whether to act |

Cross-cutting concerns are **shared services**, not controller code: event contracts,
tenant-context contracts, migration coordination, token storage, account binding,
tenant/company resolution, capability registry, execution policy, transport/pairing,
job lifecycle/retry, events infrastructure, observability.

The decision is recorded as typed constants: `CONTROLLER_REGISTER`,
`SHARED_SERVICE_REGISTER` and `EVENT_CATALOGUE` in `backend/contracts/controllers/`.
The register maps each controller to the modules that implement it **today**; the
contract test asserts every path exists and that each row's publish/consume lists
equal what the catalogue derives.

Owners (only what was approved): shared event/tenant-context contracts and migration
coordination — `control-tower (interim)`; token storage, account binding,
tenant/company resolution, capability registry, execution policy —
`a9 (proposed, unconfirmed)`; transport/pairing, job lifecycle/retry, events
infrastructure, observability — `UNASSIGNED`. Controllers themselves are
`UNASSIGNED` until an owner is approved.

## Alternatives considered

1. **Keep per-area vocabularies, document the rules.** Rejected — the rules (human
   approver, honest outcome) are exactly what convention failed to hold.
2. **One "orchestrator" that owns everything.** Rejected — collapses the
   decide/execute split that makes "Channel Execution never decides" testable.
3. **Introduce a new bus now.** Rejected for this step — out of scope (no second
   event bus); see ADR-0002.

## Consequences

- Nothing at runtime changes. No service imports the contracts yet.
- Adopting a controller = making its existing modules publish catalogue envelopes
  through `checkEventPublication`; each adoption is its own reviewed change.
- `leadOutreachExecution/approvalQueue.ts` / `approval.ts` approve outreach *tasks*
  today (a9 outreach track); the register maps them to Lead Intelligence per the
  programme brief, flagged for ownership confirmation.
- Human approval is enforced **structurally only**: LeadApproved / LeadRejected must
  carry `approver_kind: 'human'` and a uuid `approver_user_id`, and only Lead
  Intelligence may publish them. The contract cannot verify that the id belongs to an
  active user of that tenant/company or that a person made the decision; the Lead
  Intelligence producer must verify both at runtime before publishing.
- `platformConnectors` return `{ success: boolean }`, which cannot express
  accepted / delivered / unknown. Mapping that to the outcome vocabulary is
  adoption work for Channel Execution, not done here.
