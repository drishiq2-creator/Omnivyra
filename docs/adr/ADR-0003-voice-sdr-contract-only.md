# ADR-0003 — Voice SDR is contract-only

**Status:** Proposed (2026-11-28)

## Context

No voice implementation exists. `backend/services/leadOutreachExecution/channelCapabilityModel.ts`
declares channel `voice` with `transportImplemented: false`, `routable: false`, and every
operation `NOT_OPERATIONAL` / unsupported. It also records that a call disposition must be
stated separately from send and from any business assessment.

## Decision

Voice SDR exists only as a contract:

- It consumes exactly one event, `VoiceSessionRequested`, produced only by Outreach
  Orchestration. The catalogue integrity check and `checkEventPublication` both refuse any
  other source (including any envelope whose `target_controller` is `voice_sdr`).
- It publishes `VoiceSessionStarted`, `VoiceSessionCompleted`, `VoiceSessionFailed` and
  `VoiceSessionOutcomeUnknown`. They carry a technical `call_outcome` from the shared outcome
  vocabulary, partitioned exactly like Channel Execution: Completed = attempted | accepted |
  delivered, Failed = not_attempted | failed, OutcomeUnknown = unknown (only there, with an
  `unknown_reason_code`). Completed also carries a separate `disposition_code`, so a
  connected call is never read as a business result.
- The register row has `status: 'contract_only'` and no existing modules; the test pins both.

## Consequences

- No route, worker, provider, queue or table is created for voice.
- Building Voice SDR later starts from these events; changing them is a new event version.
- Voice remains NOT_OPERATIONAL in the capability model until a transport is built and
  reviewed.
